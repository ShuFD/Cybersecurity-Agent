import json,pathlib,collections,subprocess,urllib.request
root=pathlib.Path('/home/shared/eval-runner/plan-permission-fixed-full50-20261011')
status=root/'queue-status.json'
if status.exists():print('queue',status.read_text())
for mode,port in [('progressive',14176),('cairn',14177)]:
 run=root/mode
 results=[json.loads(p.read_text()) for p in (run/'artifacts').glob('*/result.json')]
 unit=f'secheur-plan-permission-fixed-full50-{mode}-controller-20261011.service'
 report={'engine':mode,'controller':subprocess.run(['systemctl','is-active',unit],capture_output=True,text=True).stdout.strip(),'completed':len(results),'passed':sum(r.get('terminalReason')=='verified_true' for r in results),'reasons':dict(collections.Counter(r.get('terminalReason') for r in results)),'attemptDirectories':len(list((run/'work').glob('*/.planning-attempts/*')))}
 if report['controller']=='active':
  with urllib.request.urlopen(f'http://127.0.0.1:{port}/sessions',timeout=5) as response:v=json.loads(response.read())
  sessions=v if isinstance(v,list) else v.get('sessions',[])
  report['sessionStates']=dict(collections.Counter(str(s.get('state',s.get('status','unknown'))) for s in sessions))
 print(json.dumps(report))
