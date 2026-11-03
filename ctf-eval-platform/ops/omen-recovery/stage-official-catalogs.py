#!/usr/bin/env python3
"""Import official metadata; never equate downloaded compose files with readiness."""
import importlib.machinery
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def restore_intercode_placeholder(src, dst, files):
    """Preserve only the official empty marker, never solution materials."""
    placeholder = src / '.placeholder'
    if not files and placeholder.is_file() and placeholder.stat().st_size == 0:
        shutil.copy2(placeholder, dst / '.placeholder')


ROOT = Path('/home/shared/bench-harness')
sys.path.insert(0, '/home/shared/eval-runner')
backend = importlib.machinery.SourceFileLoader('field', '/home/shared/eval-runner/ctf-field-backend.py').load_module()
private = Path('/var/lib/secheur-benchmark-recovery')
private.mkdir(mode=0o700, exist_ok=True)
private.chmod(0o700)
catalog, gold, report = {}, {}, {}
verified_path = private/'verified-runtime.json'
verified = json.loads(verified_path.read_text()) if verified_path.exists() else {}
supplement_path = private/'glacier-supplement.json'
supplement = json.loads(supplement_path.read_text()) if supplement_path.exists() else {}
for bench in ('nyu','cybench','intercode-ctf'):
    source = ROOT / bench / 'upstream'
    sha = subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    rows, ready = [], []
    if bench == 'nyu':
        entries = [(p.parent.relative_to(source).as_posix(), json.loads(p.read_text()))
                   for split in ('test','development') for p in sorted((source/split).rglob('challenge.json'))]
    elif bench == 'cybench':
        entries = [(t.strip(),json.loads((source/t.strip()/'metadata/metadata.json').read_text())
                    if (source/t.strip()/'metadata/metadata.json').exists() else supplement.get(t.strip()))
                   for t in (source/'task_list.txt').read_text().splitlines() if t.strip()]
    else:
        entries = [(str(d['task_id']),d) for d in json.loads((source/'data/ctf/ic_ctf.json').read_text())]
    for rel, data in entries:
        target = bench+'/'+rel
        if data is None:
            rows.append(dict(id=target,name=rel.rsplit('/',1)[-1],benchmark=bench,
                             upstreamCommit=sha,assetComplete=False,mode='unavailable',
                             preparationStatus='source_missing'))
            continue
        src = source/rel if bench != 'intercode-ctf' else source/'data/ctf/task_assets'/rel
        if data.get('_source'):
            src = Path(data['_source'])
        dst = ROOT/bench/'challenges'/rel
        dst.mkdir(parents=True, exist_ok=True)
        answer = None
        if bench == 'nyu':
            files = [str(x) for x in data.get('files',[])]
            public = {k:v for k,v in data.items() if k not in ('flag','flags','answer','solution')}
            (dst/'challenge.json').write_text(json.dumps(public,ensure_ascii=False))
            query, answer = data.get('description',''), data.get('flag')
            network = bool(data.get('compose'))
            category = data.get('category','')
        elif bench == 'cybench':
            files, basis = backend.cybench_challenge_files(src)
            if data.get('_officialFiles'):
                files=data['_officialFiles']
            query = data.get('hard_prompt','')
            subtasks = data.get('subtasks',[])
            answer = subtasks[-1].get('answer') if subtasks else None
            network = (src/'start_docker.sh').exists() or (src/'docker-compose.yml').exists()
            if network:
                (dst/'start_docker.sh').write_text('# Official network task; launch through cyctl.\n')
            category = (data.get('categories') or [''])[0]
            # Expose attachment declarations only, not the writeup/solution README.
            (dst/'README.md').write_text('## Challenge Files\n'+''.join(f'- [{f}]({f})\n' for f in files))
        else:
            files, basis = backend.intercode_task_assets(src)
            # evalctl distinguishes statement-only tasks using the upstream's
            # empty marker. It is not an attachment and must not expose solutions.
            restore_intercode_placeholder(src, dst, files)
            query, answer = data['query'], data['gold']
            network = False
            category = (data.get('tags') or ['misc'])[0]
        missing = []
        for name in files:
            path = (src/name).resolve()
            if src.resolve() not in path.parents and path != src.resolve():
                raise ValueError('attachment outside task')
            out = dst/name
            if not path.exists():
                missing.append(name)
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir():
                shutil.copytree(path,out,dirs_exist_ok=True)
            else:
                shutil.copy2(path,out)
        complete = not missing
        mode = 'intercode-env' if bench == 'intercode-ctf' else 'docker' if network else 'file'
        row = dict(id=target,name=data.get('name') or rel.rsplit('/',1)[-1],benchmark=bench,
                   category=category,mode=mode,path=str(dst),source_path=str(dst),asset_dir=str(dst),
                   query=query,upstreamCommit=sha,assetComplete=complete,
                   preparationStatus='assets_ready' if complete and not network else 'runtime_pending')
        if data.get('_supplement'):
            row['supplementSource']='LosFuzzys/GlacierCTF2023_writeups@'+data['_officialSourceCommit']
            row['cybenchMetadataAvailable']=False
            if not data.get('_hasAnswer'):
                row['preparationStatus']='answer_pending'
        if bench == 'intercode-ctf':
            row['query'] += '\nUse /home/shared/bench-harness/intercode-ctf/icctl exec '+target+' "COMMAND" to work inside the official task environment.'
            if data.get('setup') and not (private/('setup-'+rel+'.ready')).exists():
                row['preparationStatus']='setup_pending'
        if target == 'nyu/test/2020/CSAW-Quals/crypto/smallsurp':
            row['target_url'] = 'http://100.85.231.58:15000'
            row['preparationStatus'] = 'runtime_verified'
        if target in verified:
            row['preparationStatus'] = 'runtime_verified'
            row['target_url'] = verified[target]['target_url']
        if complete and row['preparationStatus'] not in ('answer_pending','runtime_pending','setup_pending'):
            ready.append(target)
        rows.append(row)
        compose_candidates=[src/n for n in ('docker-compose.yml','docker-compose.yaml','compose.yml','compose.yaml')]
        if not any(p.exists() for p in compose_candidates) and (src/'start_docker.sh').exists():
            # These subdirectories are declared by the official start scripts.
            script=(src/'start_docker.sh').read_text()
            for child in ('dist','challenge','env'):
                if '$DIR/'+child in script:
                    compose_candidates.extend(src/child/n for n in ('docker-compose.yml','docker-compose.yaml','compose.yml','compose.yaml'))
        compose=next((p for p in compose_candidates if p.exists()),None)
        catalog[target] = dict(benchmark=bench,source=str(src),network=network,task=data if bench=='intercode-ctf' else {},
                               compose=str(compose) if compose else None,composeDirectory=str(compose.parent) if compose else None)
        if answer:
            gold[target] = dict(target_id=target,field='flag',value=answer,source=row.get('supplementSource') or bench+'@'+sha)
    (ROOT/bench/'reports').mkdir(exist_ok=True)
    (ROOT/bench/'targets.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
    (ROOT/bench/'reports/startable_targets.txt').write_text(''.join('prepared\t'+t+'\n' for t in ready))
    (ROOT/bench/'targets.jsonl').chmod(0o644)
    (ROOT/bench/'reports/startable_targets.txt').chmod(0o644)
    for directory in (ROOT/bench/'challenges', ROOT/bench/'reports'):
        for parent, dirs, names in os.walk(directory):
            Path(parent).chmod(0o755)
            for name in names:
                item=Path(parent)/name
                item.chmod(0o755 if item.stat().st_mode & 0o111 else 0o644)
    report[bench] = dict(commit=sha,targets=len(rows),ready=len(ready),runtimePending=sum(r['preparationStatus']=='runtime_pending' for r in rows),sourceMissing=[r['id'] for r in rows if r['preparationStatus']=='source_missing'],answerPending=[r['id'] for r in rows if r['preparationStatus']=='answer_pending'],setupPending=[r['id'] for r in rows if r['preparationStatus']=='setup_pending'])
    source.chmod(0o700)
    (ROOT/bench).chmod(0o755)
goldpath = Path('/home/ctf-gold/answers.jsonl')
old = {r['target_id']:r for r in map(json.loads,goldpath.read_text().splitlines())}
for key,value in gold.items():
    if key in old and old[key]['value'] != value['value']:
        raise ValueError('official answer changed: '+key)
old.update(gold)
goldpath.write_text(''.join(json.dumps(r)+'\n' for r in old.values()))
goldpath.chmod(0o600)
(private/'catalog.json').write_text(json.dumps(catalog))
(private/'catalog.json').chmod(0o600)
Path('/home/shared/eval-runner/official-benchmark-preparation-20261007.json').write_text(json.dumps(report,indent=2))
Path('/home/shared/eval-runner/official-benchmark-preparation-20261007.json').chmod(0o644)
print(json.dumps(report,indent=2))
