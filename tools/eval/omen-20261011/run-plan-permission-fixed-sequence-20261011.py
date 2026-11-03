"""One finite authorized evaluation: Progressive 50, then Cairn 50. No recurring job."""
import importlib.util,json,datetime,time,fcntl
spec=importlib.util.spec_from_file_location('queue','/home/seu/advance-plan-permission-fixed-full50-20261011.py')
queue=importlib.util.module_from_spec(spec);spec.loader.exec_module(queue)
queue.QUEUE.mkdir(parents=True,exist_ok=True)
while True:
 with (queue.QUEUE/'queue.lock').open('w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  result=queue.advance();result['checkedAt']=datetime.datetime.now().isoformat()
  (queue.QUEUE/'queue-status.json').write_text(json.dumps(result,indent=2))
 if result['status'] in ['started','needs_attention','complete']:
  print(json.dumps(result),flush=True)
 if result['status']=='complete':break
 if result['status'] not in ['started','running']:
  raise SystemExit('Evaluation queue needs attention; no further batches launched.')
 time.sleep(30)
