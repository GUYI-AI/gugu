"""Offline tests of the actual CLI's original-intent barrier. No iOS/SSH/HTTP; temp files external."""
import hashlib,importlib.util,json,pathlib,tempfile,time,unittest,uuid
HERE=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('actual_ui_cli',HERE/'ui_once.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ProtocolTests(unittest.TestCase):
    def setUp(self):
        state=HERE/'test-state';state.mkdir(exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='a-ui-protocol-',dir=state);self.addCleanup(self.temp.cleanup)
        self.run=str(uuid.uuid4());self.udid=str(uuid.uuid4()).upper()
        self.data=pathlib.Path(self.temp.name)/'Devices'/self.udid/'data';self.root=self.data/'GuguAUI'/self.run
        self.root.mkdir(parents=True,mode=0o700);self.root.chmod(0o700);(self.root/'run.marker').write_text(self.run+'\n')
        self.cfg={'status':'ADMITTED','runID':self.run,'simulatorUDID':self.udid,'controlRoot':str(self.root),'deviceDataRoot':str(self.data),'hardStopUnix':time.time()+60,'admissionSHA256':'a'*64}
        m.atomic(self.root/'lease.json',{'owned':True,'runID':self.run,'simulatorUDID':self.udid,'admissionSHA256':'a'*64,'verifiedAtUnix':time.time()})
    def pending(self):
        b={'id':str(uuid.uuid4()),'runID':self.run,'commandSHA256':'b'*64,'state':'execution_unknown','expiresAtUnix':time.time()-1}
        m.atomic(self.root/'unresolved.json',b);return b
    def receipt(self,b,late=True):
        r={'id':b['id'],'runID':self.run,'commandSHA256':b['commandSHA256'],'ok':True,'completedBeforeDeadline':not late}
        m.atomic(self.root/('result-'+b['id']+'.json'),r)
        return hashlib.sha256((self.root/('result-'+b['id']+'.json')).read_bytes()).hexdigest()
    def test_original_barrier_blocks_successor_even_after_late_receipt(self):
        b=self.pending();self.receipt(b)
        with self.assertRaises(AssertionError):m.send_once(self.cfg,self.root,{'action':'home','bundle':'com.apple.springboard'})
        self.assertEqual(m.read(self.root/'unresolved.json')['id'],b['id']);self.assertFalse((self.root/'command.json').exists())
    def test_wrong_original_id_preserves_barrier(self):
        b=self.pending();h=self.receipt(b)
        with self.assertRaises(AssertionError):m.acknowledge(self.cfg,self.root,str(uuid.uuid4()),h,'d'*64)
        self.assertTrue((self.root/'unresolved.json').exists())
    def test_wrong_receipt_digest_preserves_barrier(self):
        b=self.pending();self.receipt(b)
        with self.assertRaises(AssertionError):m.acknowledge(self.cfg,self.root,b['id'],'c'*64,'d'*64)
        self.assertTrue((self.root/'unresolved.json').exists())
    def test_receipt_for_different_command_preserves_barrier(self):
        b=self.pending();h=self.receipt({**b,'commandSHA256':'e'*64})
        with self.assertRaises(AssertionError):m.acknowledge(self.cfg,self.root,b['id'],h,'d'*64)
        self.assertTrue((self.root/'unresolved.json').exists())
    def test_missing_observation_preserves_barrier(self):
        b=self.pending();h=self.receipt(b)
        with self.assertRaises(AssertionError):m.acknowledge(self.cfg,self.root,b['id'],h,'')
        self.assertTrue((self.root/'unresolved.json').exists())
    def test_exact_explicit_ack_retains_original_id_and_late_fact(self):
        b=self.pending();h=self.receipt(b)
        ack=m.acknowledge(self.cfg,self.root,b['id'],h,'d'*64)
        self.assertEqual(ack['id'],b['id']);self.assertFalse(ack['replayed']);self.assertFalse(ack['completedBeforeDeadline'])
        self.assertFalse((self.root/'unresolved.json').exists());self.assertFalse((self.root/'command.json').exists())
    def test_timeout_is_durable_across_late_completion(self):
        self.cfg['hardStopUnix']=time.time()+.03
        value,code=m.send_once(self.cfg,self.root,{'action':'home','bundle':'com.apple.springboard'})
        self.assertEqual(code,2);self.assertEqual(value['state'],'execution_unknown')
        b=m.read(self.root/'unresolved.json');self.assertEqual(b['id'],value['id'])
        (self.root/'command.json').unlink();self.receipt(b)
        self.cfg['hardStopUnix']=time.time()+60
        with self.assertRaises(AssertionError):m.send_once(self.cfg,self.root,{'action':'home','bundle':'com.apple.springboard'})
        self.assertEqual(m.read(self.root/'unresolved.json')['id'],b['id'])
    def test_boolean_index_is_rejected_before_custody(self):
        with self.assertRaises(AssertionError):m.send_once(self.cfg,self.root,{'action':'tap','bundle':'app.gugu.chat','kind':'button','label':'test','index':True})
        self.assertFalse((self.root/'unresolved.json').exists())
    def test_unknown_bundle_is_rejected_before_custody(self):
        with self.assertRaises(AssertionError):m.send_once(self.cfg,self.root,{'action':'activate','bundle':'unapproved.bundle'})
        self.assertFalse((self.root/'unresolved.json').exists())
    def test_root_must_equal_parent_pinned_data_subdirectory(self):
        p=pathlib.Path(self.temp.name)/'input.json';m.atomic(p,self.cfg)
        self.assertEqual(m.input_root(p)[1],self.root)
        m.atomic(p,{**self.cfg,'deviceDataRoot':str(self.data.parent/'other-data')})
        with self.assertRaises(AssertionError):m.input_root(p)
    def test_admitted_crash_can_only_be_acknowledged_explicitly_after_expiry(self):
        b={**self.pending(),'state':'admitted','expiresAtUnix':time.time()+60};m.atomic(self.root/'unresolved.json',b);h=self.receipt(b,False)
        with self.assertRaises(AssertionError):m.acknowledge(self.cfg,self.root,b['id'],h,'d'*64)
        b['expiresAtUnix']=time.time()-1;m.atomic(self.root/'unresolved.json',b)
        self.assertFalse(m.acknowledge(self.cfg,self.root,b['id'],h,'d'*64)['replayed'])
if __name__=='__main__':unittest.main(verbosity=2)
