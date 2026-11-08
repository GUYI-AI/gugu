"""Private mac1 CLI. One intent, persistent unknown barrier; no SSH/HTTP/automatic replay."""
import argparse,fcntl,hashlib,json,os,pathlib,stat,sys,time,uuid

if sys.flags.optimize: raise RuntimeError('Optimized execution is unsupported for this guarded diagnostic')

def sha(data): return hashlib.sha256(data).hexdigest()
def read(path): return json.loads(path.read_text())
def syncdir(path):
    fd=os.open(path,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)

def atomic(path,value):
    temp=path.with_name(path.name+'.'+str(uuid.uuid4())+'.tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode());f.flush();os.fsync(f.fileno())
    os.replace(temp,path);syncdir(path.parent)

def input_root(path):
    cfg=read(path);root=pathlib.Path(cfg['controlRoot']);data=pathlib.Path(cfg['deviceDataRoot'])
    assert cfg['status']=='ADMITTED' and root.is_absolute() and root.resolve()==root and data.resolve()==data
    assert str(uuid.UUID(cfg['runID']))==cfg['runID'].lower()
    assert data.name=='data' and data.parent.name==cfg['simulatorUDID'] and data.parent.parent.name=='Devices'
    assert root==data/'GuguAUI'/cfg['runID']
    assert root.stat().st_uid==os.getuid() and stat.S_IMODE(root.stat().st_mode)==0o700
    assert (root/'run.marker').read_text().strip()==cfg['runID']
    # CLI checks the parent-pinned path. The iOS driver independently derives it from its actual NSHomeDirectory.
    return cfg,root

def current(cfg,root):
    lease=read(root/'lease.json');stopped=(root/'stop').exists();now=time.time()
    assert not stopped and now<cfg['hardStopUnix']
    assert lease['owned'] is True and lease['runID']==cfg['runID'] and lease['admissionSHA256']==cfg['admissionSHA256'] and lease['simulatorUDID']==cfg['simulatorUDID']
    assert type(lease['verifiedAtUnix']) in {int,float} and 0<=now-lease['verifiedAtUnix']<8

def validate_command(c):
    assert set(c)<={'action','bundle','kind','label','index','text'}
    assert c['bundle'] in {'app.gugu.chat','com.apple.springboard','com.apple.Preferences','com.apple.mobilecal'}
    assert c['action'] in {'launch','activate','home','tree','screenshot','tap','type','swipeUp','swipeDown','stop'}
    if c['action'] in {'tap','type'}:
        assert c.get('kind') in {'button','textField','secureTextField','textView','staticText','cell'}
        assert isinstance(c.get('label'),str) and 0<len(c['label'])<=256
        assert type(c.get('index')) is int and 0<=c['index']<=50
    if c['action']=='type':assert isinstance(c.get('text'),str) and 0<len(c['text'])<=4000 and c['kind'] in {'textField','secureTextField','textView'}

def matching_result(cfg,root,barrier):
    path=root/('result-'+barrier['id']+'.json')
    with path.open('r+b') as f:raw=f.read();os.fsync(f.fileno())
    v=json.loads(raw)
    assert v['id']==barrier['id'] and v['runID']==cfg['runID'] and v['commandSHA256']==barrier['commandSHA256']
    assert v.get('ok') is True and type(v.get('completedBeforeDeadline')) is bool
    return v,sha(raw)

def send_once(cfg,root,command):
    current(cfg,root)
    assert not (root/'unresolved.json').exists(), 'Original intent needs explicit reconciliation'
    assert not (root/'command.json').exists() and not list(root.glob('inflight-*'))
    c=dict(command);validate_command(c);now=time.time()
    c.update(id=str(uuid.uuid4()),runID=cfg['runID'],issuedAtUnix=now,expiresAtUnix=min(now+20,cfg['hardStopUnix']))
    data=json.dumps(c,ensure_ascii=False,separators=(',',':')).encode();assert len(data)<=16384
    barrier={'id':c['id'],'runID':cfg['runID'],'commandSHA256':sha(data),'state':'admitted','issuedAtUnix':c['issuedAtUnix'],'expiresAtUnix':c['expiresAtUnix']}
    # Retained before publication. A crash or enqueue failure keeps the barrier, never guesses zero execution.
    atomic(root/'unresolved.json',barrier)
    pending=root/('enqueue-'+c['id']+'.private.json')
    fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    os.link(pending,root/'command.json');pending.unlink();syncdir(root)
    result=root/('result-'+c['id']+'.json')
    while time.time()<c['expiresAtUnix']:
        if result.exists():
            value,receipt_sha=matching_result(cfg,root,barrier)
            if value['completedBeforeDeadline'] is True:
                atomic(root/('ack-'+c['id']+'.json'),{'kind':'synchronous-known-receipt','id':c['id'],'runID':cfg['runID'],'receiptSHA256':receipt_sha})
                (root/'unresolved.json').unlink();syncdir(root)
                return value,0
            break
        time.sleep(.2)
    barrier['state']='execution_unknown';atomic(root/'unresolved.json',barrier)
    return {'id':c['id'],'runID':cfg['runID'],'state':'execution_unknown','replayed':False},2

def acknowledge(cfg,root,original_id,receipt_sha,observation_sha):
    barrier=read(root/'unresolved.json');assert barrier['state'] in {'admitted','execution_unknown'}
    if barrier['state']=='admitted':assert time.time()>=barrier['expiresAtUnix']
    assert barrier['id']==original_id and barrier['runID']==cfg['runID']
    assert len(receipt_sha)==len(observation_sha)==64 and all(c in '0123456789abcdef' for c in receipt_sha+observation_sha)
    value,actual=matching_result(cfg,root,barrier);assert actual==receipt_sha
    # Explicit operator observation is required even if a late known receipt now exists.
    assert not list(root.glob('inflight-*')) and not (root/'command.json').exists()
    ack={'kind':'explicit-reconciliation','id':original_id,'runID':cfg['runID'],'receiptSHA256':actual,'observationSHA256':observation_sha,'completedBeforeDeadline':value['completedBeforeDeadline'],'acknowledgedAtUnix':time.time(),'replayed':False}
    atomic(root/('ack-'+original_id+'.json'),ack);(root/'unresolved.json').unlink();syncdir(root);return ack

def main():
    p=argparse.ArgumentParser();p.add_argument('--input',required=True)
    modes=p.add_mutually_exclusive_group(required=True);modes.add_argument('--command-file');modes.add_argument('--inspect-unresolved',action='store_true');modes.add_argument('--acknowledge-id')
    p.add_argument('--receipt-sha256');p.add_argument('--observation-sha256');a=p.parse_args()
    cfg,root=input_root(pathlib.Path(a.input))
    with (root/'client.lock').open('a') as lock:
        os.chmod(lock.name,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if a.inspect_unresolved:
            b=read(root/'unresolved.json');print(json.dumps({'id':b['id'],'state':b['state'],'commandSHA256':b['commandSHA256'],'knownReceiptPresent':(root/('result-'+b['id']+'.json')).exists()}));return 0
        if a.acknowledge_id:
            print(json.dumps(acknowledge(cfg,root,a.acknowledge_id,a.receipt_sha256 or '',a.observation_sha256 or '')));return 0
        value,code=send_once(cfg,root,read(pathlib.Path(a.command_file)));print(json.dumps(value,ensure_ascii=False));return code
if __name__=='__main__':sys.exit(main())
