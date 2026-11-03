from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Iterable, Optional, Tuple


SCHEMA_VERSION = 1


@dataclass(frozen=True)
class SourceRef:
    kind: str
    label: str = ""
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    raw: str = ""


@dataclass(frozen=True)
class ParseDiagnostic:
    code: str
    message: str
    field: str = ""
    severity: str = "warning"


@dataclass(frozen=True)
class TaskIdentity:
    target_id: str = ""
    title: str = ""
    goal: str = ""


@dataclass(frozen=True)
class CategoryCandidate:
    category: str
    score: int
    source: str


@dataclass(frozen=True)
class TaskClassification:
    category: str = "generic"
    subcategory: str = ""
    confidence: float = 0.0
    candidates: Tuple[CategoryCandidate, ...] = ()
    signals: Tuple[str, ...] = ()


@dataclass(frozen=True)
class EndpointDescriptor:
    protocol: str
    host: str = ""
    port: Optional[int] = None
    url: str = ""
    raw: str = ""
    confidence: float = 0.0
    source: SourceRef = field(default_factory=lambda: SourceRef(kind="unknown"))


@dataclass(frozen=True)
class AssetDescriptor:
    path: str
    kind: str = "unknown"
    exists: Optional[bool] = None
    scope: str = "unknown"
    confidence: float = 0.0
    source: SourceRef = field(default_factory=lambda: SourceRef(kind="unknown"))


@dataclass(frozen=True)
class VerificationDescriptor:
    required: bool = False
    tool: str = ""
    answer_format: str = ""


@dataclass(frozen=True)
class TaskCapabilities:
    has_http_endpoint: bool = False
    has_tcp_endpoint: bool = False
    has_assets: bool = False
    pure_attachment: bool = False
    remote_only: bool = False


@dataclass(frozen=True)
class TaskDescriptor:
    schema_version: int
    prompt_digest: str
    is_ctf: bool
    sanitized_task_text: str
    identity: TaskIdentity
    classification: TaskClassification
    mode: str
    endpoints: Tuple[EndpointDescriptor, ...]
    assets: Tuple[AssetDescriptor, ...]
    verification: VerificationDescriptor
    capabilities: TaskCapabilities
    unknowns: Tuple[str, ...] = ()
    warnings: Tuple[ParseDiagnostic, ...] = ()
    provenance: Dict[str, Tuple[SourceRef, ...]] = field(default_factory=dict)

    @property
    def target_id(self) -> str:
        return self.identity.target_id

    @property
    def category(self) -> str:
        return self.classification.category

    @property
    def primary_asset_path(self) -> str:
        return self.assets[0].path if self.assets else ""

    def first_endpoint(self, *protocols: str) -> Optional[EndpointDescriptor]:
        accepted = {str(item).lower() for item in protocols if item}
        return next(
            (item for item in self.endpoints if not accepted or item.protocol.lower() in accepted),
            None,
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Dict[str, Any]) -> "TaskDescriptor":
        data = dict(value or {})
        identity = TaskIdentity(**dict(data.get("identity") or {}))
        classification_data = dict(data.get("classification") or {})
        classification_data["candidates"] = tuple(
            CategoryCandidate(**dict(item or {})) for item in classification_data.get("candidates") or ()
        )
        classification_data["signals"] = tuple(classification_data.get("signals") or ())
        classification = TaskClassification(**classification_data)
        endpoints = tuple(
            EndpointDescriptor(
                **{
                    **dict(item or {}),
                    "source": SourceRef(**dict((item or {}).get("source") or {"kind": "unknown"})),
                }
            )
            for item in data.get("endpoints") or ()
        )
        assets = tuple(
            AssetDescriptor(
                **{
                    **dict(item or {}),
                    "source": SourceRef(**dict((item or {}).get("source") or {"kind": "unknown"})),
                }
            )
            for item in data.get("assets") or ()
        )
        verification = VerificationDescriptor(**dict(data.get("verification") or {}))
        capabilities = TaskCapabilities(**dict(data.get("capabilities") or {}))
        warnings = tuple(ParseDiagnostic(**dict(item or {})) for item in data.get("warnings") or ())
        provenance = {
            str(key): tuple(SourceRef(**dict(item or {})) for item in refs or ())
            for key, refs in dict(data.get("provenance") or {}).items()
        }
        return cls(
            schema_version=int(data.get("schema_version") or SCHEMA_VERSION),
            prompt_digest=str(data.get("prompt_digest") or ""),
            is_ctf=bool(data.get("is_ctf")),
            sanitized_task_text=str(data.get("sanitized_task_text") or ""),
            identity=identity,
            classification=classification,
            mode=str(data.get("mode") or "unknown"),
            endpoints=endpoints,
            assets=assets,
            verification=verification,
            capabilities=capabilities,
            unknowns=tuple(str(item) for item in data.get("unknowns") or ()),
            warnings=warnings,
            provenance=provenance,
        )


def source_tuple(values: Iterable[SourceRef]) -> Tuple[SourceRef, ...]:
    return tuple(values or ())
