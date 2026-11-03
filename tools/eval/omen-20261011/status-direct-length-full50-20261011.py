import json,pathlib,collections,subprocess,urllib.request
root=pathlib.Path('/home/shared/eval-runner/direct-harness-full50-20261011-length-recovery')
rows=[]
for p in (root/'artifacts').glob('*/result.json'):
 r=json.loads(p.read_text());rows.append({k:r.get(k) for k in ['targetId','terminalReason','verificationState','profile','turns','toolCalls','startedAt','endedAt','failureCode']})
unit='secheur-direct-harness-full50-controller-20261011-length-recovery.service'
active=subprocess.run(['systemctl','is-active',unit],capture_output=True,text=True).stdout.strip()
exitfile=root/'RUN-EXIT-CODE';code=int(exitfile.read_text()) if exitfile.exists() else None
status='complete' if len(rows)==50 and code==0 and active!='active' else 'running' if active=='active' else 'needs_attention'
out={'status':status,'completed':len(rows),'expected':50,'success':sum(r['terminalReason']=='verified_true' for r in rows),'stopReasons':dict(collections.Counter(r['terminalReason'] for r in rows)),'controller':active,'controllerExitCode':code}
if status=='complete':out['results']=rows
try:
 with urllib.request.urlopen('http://127.0.0.1:14175/sessions',timeout=5) as response:v=json.loads(response.read())
 sessions=v if isinstance(v,list) else v.get('sessions',[])
 out['sessionStates']=dict(collections.Counter(str(s.get('state',s.get('status','unknown'))) for s in sessions))
except Exception as e:out['bridgeCheck']=type(e).__name__
print(json.dumps(out))
