"""Small CTFd plugin exposing the api_doc.md contract to SecHeur Agent.

The plugin intentionally does not reuse CTFd's browser challenge responses. Those
responses contain rendered HTML, challenge scripts, and solve tables that are not
useful to an agent and can grow large enough to stall a model turn.
"""

from __future__ import annotations

import hmac
import json
import os
import time
import urllib.error
import urllib.request
from functools import wraps
from typing import Any, Callable

from flask import jsonify, request, url_for

from CTFd.cache import clear_challenges, clear_standings
from CTFd.models import Challenges, ChallengeFiles, Fails, Solves, Submissions, Users, db
from CTFd.plugins.challenges import get_chal_class
from CTFd.utils import get_config
from CTFd.utils.config import is_teams_mode
from CTFd.utils.dates import ctf_paused, ctftime
from CTFd.utils.security.auth import login_user
from CTFd.utils.security.signing import serialize


AGENT_PREFIX = "/slab-match/api/v1/agent"
MAX_BODY_BYTES = 64 * 1024
MAX_FLAG_LENGTH = 256


class AgentApiError(Exception):
    def __init__(self, message: str, code: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class GatewayResponseError(Exception):
    def __init__(self, status: int, payload: dict[str, Any]) -> None:
        super().__init__(str(payload.get("message", "CTF lab gateway request failed")))
        self.status = status
        self.payload = payload


class AgentSubmissionRequest:
    """The CTFd challenge interface expects a ``submission`` field.

    The public agent contract calls it ``flag``. A small request-shaped wrapper
    keeps CTFd challenge plugins reusable without mutating Flask's request data.
    """

    def __init__(self, submission: str) -> None:
        self.form: dict[str, str] = {}
        self._json = {"submission": submission}
        self.access_route = request.access_route
        self.remote_addr = request.remote_addr

    def get_json(self) -> dict[str, str]:
        return self._json


def _envelope(data: Any = None, code: str = "00000", message: str = ""):
    return jsonify({"code": code, "message": message, "data": data if data is not None else {}})


def _agent_route(view: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(view)
    def wrapped(*args: Any, **kwargs: Any):
        try:
            _authenticate()
            return view(*args, **kwargs)
        except AgentApiError as error:
            return _envelope(code=error.code, message=str(error)), error.status
        except GatewayResponseError as error:
            return _envelope(code="gateway_error", message=str(error)), 502
        except Exception:
            from flask import current_app

            current_app.logger.exception("SecHeur CTFd agent API request failed")
            return _envelope(code="internal_error", message="Internal agent API error"), 500

    # The agent authenticates with X-Agent-AccessKey rather than a browser CSRF
    # nonce. CTFd checks this marker before executing the route.
    wrapped._bypass_csrf = True  # type: ignore[attr-defined]
    return wrapped


def _configured_user() -> Users | None:
    raw_user_id = os.environ.get("CTFD_AGENT_USER_ID", "").strip()
    if not raw_user_id:
        return None
    try:
        user_id = int(raw_user_id)
    except ValueError as error:
        raise AgentApiError("CTFD_AGENT_USER_ID must be an integer", "agent_user_invalid", 503) from error
    user = Users.query.filter_by(id=user_id).first()
    if user is None:
        raise AgentApiError("Configured CTFd agent user does not exist", "agent_user_missing", 503)
    return user


def _authenticate() -> Users | None:
    expected = os.environ.get("CTFD_AGENT_ACCESS_KEY", "").strip()
    if not expected:
        raise AgentApiError("CTFd agent API is disabled", "agent_api_disabled", 503)
    provided = request.headers.get("X-Agent-AccessKey", "")
    if not provided or not hmac.compare_digest(provided, expected):
        raise AgentApiError("Invalid agent access key", "unauthorized", 401)

    user = _configured_user()
    if user is not None:
        login_user(user)
    return user


def _require_user() -> Users:
    user = _configured_user()
    if user is None:
        raise AgentApiError("CTFD_AGENT_USER_ID is required for this operation", "agent_user_required", 503)
    return user


def _body() -> dict[str, Any]:
    if request.content_length and request.content_length > MAX_BODY_BYTES:
        raise AgentApiError("Request body is too large", "invalid_request", 413)
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        raise AgentApiError("Request body must be a JSON object", "invalid_request", 400)
    return value


def _challenge(exercise_id: Any) -> Challenges:
    try:
        challenge_id = int(exercise_id)
    except (TypeError, ValueError) as error:
        raise AgentApiError("exerciseId must be an integer", "invalid_exercise_id", 400) from error
    challenge = Challenges.query.filter_by(id=challenge_id).first()
    if challenge is None:
        raise AgentApiError("Challenge does not exist", "exercise_not_found", 404)
    return challenge


def _is_solved(challenge: Challenges, user: Users | None) -> bool:
    if user is None:
        return False
    query = Solves.query.filter_by(challenge_id=challenge.id)
    if is_teams_mode():
        return bool(user.team_id and query.filter_by(team_id=user.team_id).first())
    return bool(query.filter_by(user_id=user.id).first())


def _attempt_count(challenge: Challenges, user: Users | None) -> int:
    if user is None:
        return 0
    query = Submissions.query.filter_by(challenge_id=challenge.id)
    if is_teams_mode():
        return query.filter_by(team_id=user.team_id).count() if user.team_id else 0
    return query.filter_by(user_id=user.id).count()


def _file_url(file: ChallengeFiles, user: Users | None) -> str:
    if user is None:
        return url_for("views.files", path=file.location)
    team = user.team
    token = {"user_id": user.id, "team_id": team.id if team else None, "file_id": file.id}
    return url_for("views.files", path=file.location, token=serialize(token))


def _attachments(challenge: Challenges, user: Users | None) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for file in challenge.files:
        name = str(file.location).replace("\\", "/").rsplit("/", 1)[-1] or f"attachment-{file.id}"
        ext = name.rsplit(".", 1)[-1] if "." in name else ""
        values.append(
            {
                "id": file.id,
                "name": name,
                "url": _file_url(file, user),
                **({"ext": ext} if ext else {}),
            }
        )
    return values


def _gateway_url() -> str:
    return (
        os.environ.get("CTFD_AGENT_GATEWAY_URL", "").strip()
        or os.environ.get("CTF_LAB_GATEWAY_URL", "").strip()
    ).rstrip("/")


def _gateway_request(method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    base = _gateway_url()
    if not base:
        raise AgentApiError("CTF lab gateway is not configured", "environment_gateway_unconfigured", 503)
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{base}{path}",
        data=body,
        method=method,
        headers={"Accept": "application/json", **({"Content-Type": "application/json"} if body else {})},
    )
    timeout = max(1.0, float(os.environ.get("CTFD_AGENT_GATEWAY_TIMEOUT_SECONDS", "20")))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read(MAX_BODY_BYTES)
            value = json.loads(raw.decode("utf-8")) if raw else {}
            return response.status, value if isinstance(value, dict) else {}
    except urllib.error.HTTPError as error:
        raw = error.read(MAX_BODY_BYTES)
        try:
            value = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            value = {}
        return error.code, value if isinstance(value, dict) else {}
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise AgentApiError(f"CTF lab gateway request failed: {error}", "environment_gateway_error", 502) from error


def _gateway_data(exercise_id: int) -> dict[str, Any] | None:
    status, value = _gateway_request("GET", f"/v1/environments/{exercise_id}")
    if status == 404:
        return None
    if status < 200 or status >= 300:
        raise GatewayResponseError(status, value)
    return value


def _environment(challenge: Challenges) -> dict[str, Any]:
    required = bool(str(challenge.connection_info or "").strip())
    if not required:
        return {
            "required": False,
            "endpoints": [],
            "isNeedInit": False,
            "isNeedCheck": False,
            "endpointType": "none",
        }
    if not _gateway_url():
        return {
            "required": True,
            "endpoints": [],
            "isNeedInit": True,
            "isNeedCheck": False,
            "endpointType": "tcp",
        }
    value = _gateway_data(challenge.id)
    endpoints = value.get("endpoints", []) if value else []
    if not isinstance(endpoints, list):
        endpoints = []
    ready = bool(endpoints) and str(value.get("status", "")) in {"ready", "active"} if value else False
    return {
        "required": True,
        "endpoints": endpoints,
        "isNeedInit": not ready,
        "isNeedCheck": bool(value and not ready),
        "endpointType": "tcp",
        **(
            {
                "leaseId": value.get("lease_id"),
                "expiresAt": value.get("expires_at"),
            }
            if value
            else {}
        ),
    }


def _summary(challenge: Challenges, user: Users | None) -> dict[str, Any]:
    return {
        "id": challenge.id,
        "name": challenge.name,
        "category": challenge.category,
        "value": challenge.value,
        "order": challenge.id,
        "isOpen": challenge.state not in {"hidden", "locked", "closed"},
        "hasSolved": _is_solved(challenge, user),
        "maxAttempts": challenge.max_attempts,
    }


def _details(challenge: Challenges, user: Users | None) -> dict[str, Any]:
    environment = _environment(challenge)
    solved = _is_solved(challenge, user)
    return {
        "id": challenge.id,
        "name": challenge.name,
        "description": challenge.description or "",
        "category": challenge.category,
        "hasSolved": solved,
        "score": str(challenge.value or 0),
        "value": challenge.value,
        "difficulty": None,
        "maxAttempts": challenge.max_attempts,
        "attempts": _attempt_count(challenge, user),
        "isOpen": challenge.state not in {"hidden", "locked", "closed"},
        "connectionInfo": challenge.connection_info or "",
        "attachment": {"files": _attachments(challenge, user)},
        "endpoints": environment["endpoints"],
        "endpointType": environment["endpointType"],
        "canRefreshEndpoint": False,
        "isNeedInit": environment["isNeedInit"],
        "isNeedCheck": environment["isNeedCheck"],
        "currentTime": int(time.time() * 1000),
        "flagFormat": {"prefix": "", "suffix": "", "accepts": "either", "submit": "full"},
    }


def _overview(user: Users) -> dict[str, Any]:
    account = user.team if is_teams_mode() else user
    if account is None:
        return {"stagePoint": 0, "stageRank": None}
    return {
        "stagePoint": account.get_score(admin=user.type == "admin"),
        "stageRank": account.get_place(admin=user.type == "admin", numeric=True),
    }


def _forward_environment(method: str, exercise_id: int) -> dict[str, Any]:
    path = f"/v1/environments/{exercise_id}" if method == "DELETE" else "/v1/environments"
    status, value = _gateway_request(method, path, None if method == "DELETE" else {"exerciseId": str(exercise_id)})
    if status < 200 or status >= 300:
        raise GatewayResponseError(status, value)
    return value


def _answer(user: Users, challenge: Challenges, flag: str) -> dict[str, Any]:
    if ctf_paused():
        raise AgentApiError("CTFd is paused", "paused", 403)
    if challenge.state in {"hidden", "locked", "closed"}:
        raise AgentApiError("Challenge is not open", "challenge_closed", 403)
    if _is_solved(challenge, user):
        return {
            "exerciseId": challenge.id,
            "isCorrect": True,
            "status": "already_solved",
            "message": "You already solved this",
        }

    account_filter = {"team_id": user.team_id} if is_teams_mode() else {"user_id": user.id}
    fails = Fails.query.filter_by(challenge_id=challenge.id, **account_filter).count()
    if challenge.max_attempts and fails >= challenge.max_attempts:
        return {
            "exerciseId": challenge.id,
            "isCorrect": False,
            "status": "attempt_limit",
            "message": "You have 0 tries remaining",
        }

    submitted = AgentSubmissionRequest(flag)
    challenge_class = get_chal_class(challenge.type)
    correct, message = challenge_class.attempt(challenge, submitted)
    if correct:
        if ctftime() or user.type == "admin":
            challenge_class.solve(user=user, team=user.team, challenge=challenge, request=submitted)
            clear_standings()
            clear_challenges()
        return {
            "exerciseId": challenge.id,
            "isCorrect": True,
            "status": "correct",
            "message": message,
        }

    if ctftime() or user.type == "admin":
        challenge_class.fail(user=user, team=user.team, challenge=challenge, request=submitted)
        db.session.commit()
        clear_standings()
        clear_challenges()
    attempts_left = max(0, challenge.max_attempts - fails - 1) if challenge.max_attempts else None
    return {
        "exerciseId": challenge.id,
        "isCorrect": False,
        "status": "incorrect",
        "message": message,
        **({"attemptsLeft": attempts_left} if attempts_left is not None else {}),
    }


def load(app) -> None:
    @app.route(f"{AGENT_PREFIX}/match/notice/match-info", methods=["GET"])
    @_agent_route
    def agent_match_info():
        name = get_config("ctf_name", default="Local CTFd")
        return _envelope(
            {
                "note": f"SecHeur Agent interface for {name}",
                "rule": "Use exercise details before solving; submit only evidence-backed flags through the answer endpoint.",
                "flagFormat": {"prefix": "", "suffix": "", "accepts": "either", "submit": "full"},
                "maxAttempts": 3,
            }
        )

    @app.route(f"{AGENT_PREFIX}/answer-panel/overview", methods=["GET"])
    @_agent_route
    def agent_overview():
        return _envelope(_overview(_require_user()))

    @app.route(f"{AGENT_PREFIX}/ctf/exercise-list", methods=["GET"])
    @_agent_route
    def agent_exercise_list():
        user = _configured_user()
        challenges = Challenges.query.order_by(Challenges.id.asc()).all()
        return _envelope([_summary(challenge, user) for challenge in challenges])

    @app.route(f"{AGENT_PREFIX}/ctf/exercise", methods=["GET"])
    @_agent_route
    def agent_exercise():
        user = _configured_user()
        return _envelope(_details(_challenge(request.args.get("exerciseId")), user))

    @app.route(f"{AGENT_PREFIX}/ctf/build-exercise-env", methods=["POST"])
    @_agent_route
    def agent_build_environment():
        challenge = _challenge(_body().get("exerciseId"))
        if not str(challenge.connection_info or "").strip():
            return _envelope({"exerciseId": challenge.id, "status": "not_required", "endpoints": []})
        return _envelope(_forward_environment("POST", challenge.id))

    @app.route(f"{AGENT_PREFIX}/ctf/recover-exercise-env", methods=["POST"])
    @_agent_route
    def agent_recover_environment():
        challenge = _challenge(_body().get("exerciseId"))
        if not str(challenge.connection_info or "").strip() or not _gateway_url():
            return _envelope({"exerciseId": challenge.id, "released": False, "reason": "not_required"})
        return _envelope(_forward_environment("DELETE", challenge.id))

    @app.route(f"{AGENT_PREFIX}/answer-panel/answer", methods=["POST"])
    @_agent_route
    def agent_answer():
        body = _body()
        flag = body.get("flag", body.get("submission"))
        if not isinstance(flag, str) or not flag.strip():
            raise AgentApiError("flag must be a non-empty string", "invalid_flag", 400)
        if len(flag) > MAX_FLAG_LENGTH:
            raise AgentApiError("flag is too long", "invalid_flag", 400)
        user = _require_user()
        return _envelope(_answer(user, _challenge(body.get("exerciseId")), flag.strip()))
