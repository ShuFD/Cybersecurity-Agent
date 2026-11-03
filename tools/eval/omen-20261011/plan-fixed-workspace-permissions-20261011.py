"""Real controller/bridge identity checks for the private PLAN evaluation workspace."""
import grp,json,os,pwd,shutil,subprocess,sys,uuid
from pathlib import Path

def run_as(account, code, *args):
    user=pwd.getpwnam(account);group=grp.getgrnam('shared')
    def drop():
        os.setgroups([group.gr_gid]);os.setgid(group.gr_gid);os.setuid(user.pw_uid)
        os.umask(0o007)
    return subprocess.run([sys.executable,'-c',code,*map(str,args)],preexec_fn=drop,capture_output=True,text=True,check=True)

def prepare_work_root(path):
    path=Path(path).resolve()
    boundary=Path('/home/shared/eval-runner/plan-permission-fixed-full50-20261011').resolve()
    if path not in [boundary/'progressive'/'work',boundary/'cairn'/'work']:
        raise ValueError('Unexpected PLAN work root')
    path.mkdir(parents=True,exist_ok=True)
    os.chown(path,pwd.getpwnam('seu').pw_uid,grp.getgrnam('shared').gr_gid)
    os.chmod(path,0o2770)
    return path

def verify_work_root(path):
    path=Path(path).resolve();fixture=path/('permission-preflight-'+uuid.uuid4().hex)
    try:
        run_as('seu',"from pathlib import Path;import sys;p=Path(sys.argv[1]);p.mkdir();(p/'controller.txt').write_text('synthetic controller fixture')",fixture)
        run_as('pi-eval',"from pathlib import Path;import sys;p=Path(sys.argv[1]);a=p/'.planning-attempts'/'fixture';a.mkdir(parents=True);(a/'executor.txt').write_text('synthetic executor fixture');assert (p/'controller.txt').read_text()",fixture)
        run_as('seu',"from pathlib import Path;import sys;p=Path(sys.argv[1]);assert (p/'.planning-attempts'/'fixture'/'executor.txt').read_text()",fixture)
        return {'controller':'seu:shared','executor':'pi-eval:shared','workRootMode':oct(path.stat().st_mode&0o7777),'crossAccountWrite':'passed'}
    finally:
        if fixture.parent != path:raise ValueError('Unexpected fixture path')
        if fixture.exists():shutil.rmtree(fixture)

if __name__=='__main__':
    print(json.dumps({mode:verify_work_root(prepare_work_root(Path('/home/shared/eval-runner/plan-permission-fixed-full50-20261011')/mode/'work')) for mode in ['progressive','cairn']}))
