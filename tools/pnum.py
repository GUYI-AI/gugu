import subprocess,sys,re,collections
base,head=sys.argv[1],sys.argv[2]  # run inside a worktree; head may be HEAD (committed only)
out=subprocess.run(['git','diff','--numstat','-M',base,head],capture_output=True,text=True).stdout
T=re.compile(r'(^tests/|/tests?/|\.test\.|\.spec\.|__tests__|/test-support/)')
rows=[]
for l in out.splitlines():
    a,d,f=l.split('\t',2)
    if a=='-': continue
    rows.append((int(a),int(d),f,bool(T.search(f))))
pa=sum(r[0] for r in rows if not r[3]);pd=sum(r[1] for r in rows if not r[3])
ta=sum(r[0] for r in rows if r[3]);td=sum(r[1] for r in rows if r[3])
print(f"product +{pa} -{pd} net {pa-pd}; tests +{ta} -{td} net {ta-td}")
if len(sys.argv)>3:
    for a,d,f,t in sorted([r for r in rows if not r[3]],key=lambda r:-(r[0]-r[1]))[:int(sys.argv[3])]:
        print(a-d,a,d,f)
