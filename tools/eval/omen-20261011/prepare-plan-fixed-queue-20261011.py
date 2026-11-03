import importlib.util,json
spec=importlib.util.spec_from_file_location('queue','/home/seu/advance-plan-permission-fixed-full50-20261011.py')
queue=importlib.util.module_from_spec(spec);spec.loader.exec_module(queue)
queue.validate_release()
targets=json.loads((queue.DIRECT/'targets.json').read_text())
assert len(targets)==len(set(targets))==50
assert queue.complete(queue.DIRECT,targets,'secheur-direct-harness-full50-controller-20261011-length-recovery')
reports={}
for mode in queue.MODES:
 queue.prepare(mode)
 reports[mode]=queue.permission_module.verify_work_root(queue.permission_module.prepare_work_root(queue.root_for(mode)/'work'))
 cfg=json.loads((queue.root_for(mode)/'config.json').read_text())
 assert cfg['maxTurns']==220 and cfg['wallTimeoutSeconds']==3000 and cfg['controllerConcurrency']==5 and cfg['executionCapacity']==2
 assert json.loads((queue.root_for(mode)/'targets.json').read_text())==targets
print(json.dumps({'status':'preflight_passed','targets':50,'engines':reports,'maxTurns':220,'wallTimeoutSeconds':3000,'controllerConcurrency':5,'executionCapacity':2}))
