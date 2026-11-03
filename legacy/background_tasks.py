from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import uuid


@dataclass
class BackgroundTask:
    task_id: str
    status: str
    command: list[str]
    cwd: str
    output_path: str
    pid: int
    process: subprocess.Popen
    started_at: float
    ended_at: float | None = None
    exit_code: int | None = None
    tmp_path: str | None = None
    notification_sent: bool = False


_TASKS: dict[str, BackgroundTask] = {}
_LOCK = threading.RLock()


def _startup_kwargs():
    if os.name != "nt":
        return {"start_new_session": True}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 0
    return {"startupinfo": startupinfo, "creationflags": 0x08000000}


def _cleanup_tmp_path(task: BackgroundTask):
    if not task.tmp_path:
        return
    try:
        Path(task.tmp_path).unlink(missing_ok=True)
    except Exception:
        pass
    task.tmp_path = None


def _terminate_process_tree(process: subprocess.Popen):
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True)
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        process.terminate()


def _kill_process_tree(process: subprocess.Popen):
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True)
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        process.kill()


def _finalize_task(task: BackgroundTask, exit_code: int):
    task.exit_code = exit_code
    task.status = "completed" if exit_code == 0 else "failed"
    task.ended_at = time.time()
    _cleanup_tmp_path(task)


def _monitor_task(task_id: str):
    with _LOCK:
        task = _TASKS.get(task_id)
    if not task:
        return
    exit_code = task.process.wait()
    with _LOCK:
        current = _TASKS.get(task_id)
        if current is task and task.status == "running":
            _finalize_task(task, exit_code)


def start_background_task(command, cwd, output_dir, tmp_path=None):
    # The Pi host supplies private writable storage independent of the command cwd.
    output_dir = Path(os.environ.get("SECHEUR_COMMAND_TASK_OUTPUT_DIR") or output_dir)
    task_id = f"task_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
    output_path = output_dir / f"{task_id}.out"
    log_file = None
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        log_file = output_path.open("wb")
        process = subprocess.Popen(
            list(command),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            **_startup_kwargs(),
        )
    except Exception:
        if log_file:
            log_file.close()
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except Exception:
                pass
        raise
    finally:
        try:
            log_file.close()
        except Exception:
            pass

    task = BackgroundTask(
        task_id=task_id,
        status="running",
        command=list(command),
        cwd=str(cwd),
        output_path=str(output_path),
        pid=process.pid,
        process=process,
        started_at=time.time(),
        tmp_path=str(tmp_path) if tmp_path else None,
    )
    with _LOCK:
        _TASKS[task_id] = task
    threading.Thread(target=_monitor_task, args=(task_id,), daemon=True).start()
    return task


def get_background_task(task_id, max_chars=20000):
    with _LOCK:
        task = _TASKS.get(str(task_id or ""))
        if not task:
            return None
        exit_code = task.process.poll()
        if exit_code is not None and task.status == "running":
            _finalize_task(task, exit_code)
        snapshot = {
            "task_id": task.task_id,
            "status": task.status,
            "pid": task.pid,
            "output_path": task.output_path,
            "cwd": task.cwd,
            "started_at": task.started_at,
            "ended_at": task.ended_at,
            "exit_code": task.exit_code,
        }
    try:
        stdout = Path(snapshot["output_path"]).read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        stdout = f"[output unavailable: {exc}]"
    if max_chars and len(stdout) > max_chars:
        stdout = stdout[-max_chars:]
        snapshot["truncated"] = True
    else:
        snapshot["truncated"] = False
    snapshot["stdout"] = stdout
    return snapshot


def drain_completed_background_tasks(max_chars=2000):
    task_ids = []
    with _LOCK:
        for task_id, task in _TASKS.items():
            exit_code = task.process.poll()
            if exit_code is not None and task.status == "running":
                _finalize_task(task, exit_code)
            if task.status in {"completed", "failed"} and not task.notification_sent:
                task.notification_sent = True
                task_ids.append(task_id)
    return [snapshot for task_id in task_ids if (snapshot := get_background_task(task_id, max_chars=max_chars))]


def stop_background_task(task_id, kill_process_tree=None):
    with _LOCK:
        task = _TASKS.get(str(task_id or ""))
        if task and task.status == "running":
            task.status = "stopping"
    if not task:
        return None
    if task.status == "stopping":
        if kill_process_tree:
            kill_process_tree(task.process)
        else:
            _terminate_process_tree(task.process)
        exit_code = task.process.poll()
        if exit_code is None:
            try:
                exit_code = task.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if kill_process_tree:
                    kill_process_tree(task.process)
                else:
                    _kill_process_tree(task.process)
                exit_code = task.process.wait(timeout=5)
        with _LOCK:
            task.status = "stopped"
            task.exit_code = exit_code
            task.ended_at = time.time()
            _cleanup_tmp_path(task)
    return get_background_task(task_id)


def reset_background_tasks(kill_process_tree=None):
    with _LOCK:
        task_ids = list(_TASKS)
    for task_id in task_ids:
        stop_background_task(task_id, kill_process_tree=kill_process_tree)
    with _LOCK:
        _TASKS.clear()
