"""Strong crypto gate and attack-pattern taxonomy for v1."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .schema import GateResult


@dataclass(frozen=True)
class PatternRule:
    label: str
    crypto_type: str
    regex: str
    weight: float = 1.0


# The labels intentionally describe attack paths, not only primitives.  This is
# the core retrieval field: the agent wants to recall similar exploit structure.
ATTACK_RULES: tuple[PatternRule, ...] = (
    PatternRule(
        "rsa small exponent eth root",
        "RSA",
        r"\b(?:small\s+e|e\s*=\s*3|cube\s*root|integer\s+root|iroot|low\s+exponent)\b",
        2.2,
    ),
    PatternRule("rsa common modulus", "RSA", r"\bcommon\s+modulus\b|\bsame\s+n\b", 2.4),
    PatternRule(
        "rsa broadcast hastad",
        "RSA",
        r"\bhastad|broadcast\s+attack\b|CRT\s+combine",
        2.4,
    ),
    PatternRule(
        "rsa wiener small d", "RSA", r"\bwiener|small\s+d\b|continued\s+fraction", 2.4
    ),
    PatternRule(
        "rsa fermat close primes",
        "RSA",
        r"\bfermat\b|close\s+primes|consecutive\s+primes",
        2.0,
    ),
    PatternRule(
        "rsa coppersmith small roots",
        "RSA",
        r"\bcoppersmith|small_roots?|partial\s+prime|related\s+message|franklin[- ]reiter",
        2.8,
    ),
    PatternRule(
        "rsa oracle multiplicative",
        "RSA",
        r"\b(?:padding|lsb|parity|manger|bleichenbacher|decryption)\s+oracle\b|multiplicative\s+homomorphism",
        2.6,
    ),
    PatternRule(
        "rsa crt fault",
        "RSA",
        r"\bCRT\s+fault|bellcore|faulty\s+signature|gcd\s*\(\s*s\^?e",
        2.5,
    ),
    PatternRule(
        "rsa batch gcd shared prime",
        "RSA",
        r"\bbatch\s+gcd|shared\s+prime|gcd\s*\(\s*n",
        2.2,
    ),
    PatternRule(
        "ecdsa nonce reuse",
        "ECC/Signature",
        r"\b(?:ECDSA|DSA|Schnorr)\b[\s\S]{0,120}\b(?:nonce\s+reuse|reused\s+k|same\s+r|biased\s+nonce|partial\s+nonce)",
        2.8,
    ),
    PatternRule(
        "ecc small subgroup invalid curve",
        "ECC",
        r"\b(?:small\s+subgroup|invalid\s+curve|singular\s+curve|smart'?s\s+attack|anomalous\s+curve|pohlig[- ]hellman)\b",
        2.5,
    ),
    PatternRule(
        "discrete log smooth order",
        "ECC/NumberTheory",
        r"\b(?:discrete\s+log|DLP|baby[- ]step|giant[- ]step|BSGS|pohlig[- ]hellman)\b",
        1.8,
    ),
    PatternRule(
        "lattice lll coppersmith",
        "Lattice",
        r"\b(?:LLL|BKZ|CVP|SVP|Babai|fpylll|lattice|small_roots?|hidden\s+number\s+problem|HNP)\b",
        2.7,
    ),
    PatternRule(
        "lwe ring-lwe cvp",
        "Lattice/LWE",
        r"\b(?:LWE|RLWE|Ring[- ]LWE|Module[- ]LWE|Learning\s+With\s+Errors|CVP|error\s+vector)\b",
        2.8,
    ),
    PatternRule(
        "prng state recovery",
        "PRNG",
        r"\b(?:MT19937|mersenne|untemper|randcrack|LCG|LFSR|xorshift|srand|Math\.random|seed\s+recovery|state\s+recovery|truncated\s+output)\b",
        2.6,
    ),
    PatternRule(
        "stream cipher keystream reuse",
        "StreamCipher",
        r"\b(?:many[- ]time\s+pad|OTP\s+reuse|keystream\s+reuse|crib\s+drag|known\s+plaintext|RC4\s+bias|Berlekamp[- ]Massey)\b",
        2.5,
    ),
    PatternRule(
        "xor key recovery",
        "Classic/XOR",
        r"\b(?:xor|repeating[- ]key|single[- ]byte\s+xor|multi[- ]byte\s+xor)\b[\s\S]{0,160}\b(?:known\s+plaintext|frequency|crib|key\s+recover)",
        1.7,
    ),
    PatternRule(
        "cbc padding oracle",
        "BlockCipher",
        r"\b(?:CBC|PKCS#?7)\b[\s\S]{0,140}\bpadding\s+oracle\b|\bpadding\s+oracle\b[\s\S]{0,140}\bCBC\b",
        2.7,
    ),
    PatternRule(
        "cbc bit flipping",
        "BlockCipher",
        r"\b(?:CBC|IV)\b[\s\S]{0,120}\b(?:bit[- ]flip|bitflipping|flip\s+bits|forge\s+plaintext)\b",
        2.2,
    ),
    PatternRule(
        "ecb cut and paste",
        "BlockCipher",
        r"\bECB\b[\s\S]{0,120}\b(?:cut[- ]and[- ]paste|block\s+shuffle|byte[- ]at[- ]a[- ]time|chosen\s+plaintext)",
        2.3,
    ),
    PatternRule(
        "gcm nonce reuse",
        "BlockCipher/MAC",
        r"\b(?:GCM|GHASH)\b[\s\S]{0,120}\b(?:nonce\s+reuse|forbidden\s+attack|authentication\s+key)",
        2.8,
    ),
    PatternRule(
        "hash length extension",
        "Hash/MAC",
        r"\b(?:length\s+extension|hashpump|Merkle[- ]Damgard|secret\s*\|\|\s*message)\b",
        2.5,
    ),
    PatternRule(
        "crc linear forgery",
        "Hash/MAC",
        r"\b(?:CRC32?|CRC)\b[\s\S]{0,120}\b(?:linear|collision|forge|append|GF\(2\))",
        2.2,
    ),
    PatternRule(
        "mac forgery linearity",
        "Hash/MAC",
        r"\b(?:MAC|HMAC|signature)\b[\s\S]{0,140}\b(?:forge|linearity|xor|collision|extension)",
        2.0,
    ),
    PatternRule(
        "shamir secret sharing misuse",
        "SecretSharing",
        r"\b(?:Shamir|SSS|secret\s+sharing|polynomial\s+share)\b[\s\S]{0,160}\b(?:reuse|interpolation|lagrange|coefficients?)",
        2.4,
    ),
    PatternRule(
        "zk proof forgery",
        "ZKP",
        r"\b(?:Groth16|SNARK|ZKP|zero[- ]knowledge|KZG|proof)\b[\s\S]{0,160}\b(?:forge|replay|broken\s+setup|oracle|unconstrained)",
        2.2,
    ),
    PatternRule(
        "knapsack subset sum lattice",
        "Lattice",
        r"\b(?:knapsack|subset\s+sum|Merkle[- ]Hellman)\b[\s\S]{0,120}\b(?:LLL|lattice|low\s+density)",
        2.4,
    ),
)

PRIMITIVE_RULES: tuple[PatternRule, ...] = (
    PatternRule(
        "RSA",
        "RSA",
        r"\bRSA\b|\bmodulus\b|\bpublic\s+exponent\b|\bphi\s*\(|\bn\s*=\s*p\s*\*\s*q\b|pow\s*\([^)]*,\s*e\s*,\s*n\s*\)",
    ),
    PatternRule(
        "ECC",
        "ECC",
        r"\bECC\b|elliptic\s+curve|\bECDSA\b|\bEd25519\b|\bcurve25519\b|\bsecp\w+|\bpoint\s+addition\b",
    ),
    PatternRule(
        "lattice",
        "Lattice",
        r"\blattice\b|\bLLL\b|\bBKZ\b|\bfpylll\b|\bSageMath\b|small_roots?\s*\(",
    ),
    PatternRule(
        "LWE",
        "Lattice/LWE",
        r"\bLWE\b|Ring[- ]LWE|Module[- ]LWE|Learning\s+With\s+Errors",
    ),
    PatternRule(
        "PRNG",
        "PRNG",
        r"\bPRNG\b|\bLCG\b|\bLFSR\b|\bMT19937\b|mersenne|xorshift|\brand\s*\(|srand\s*\(",
    ),
    PatternRule(
        "AES",
        "BlockCipher",
        r"\bAES\b|\bCBC\b|\bECB\b|\bCTR\b|\bGCM\b|\bIV\b|\bblock\s+cipher\b",
    ),
    PatternRule(
        "stream cipher",
        "StreamCipher",
        r"\bRC4\b|stream\s+cipher|keystream|one[- ]time\s+pad|\bOTP\b",
    ),
    PatternRule(
        "hash",
        "Hash/MAC",
        r"\bSHA-?\d+\b|\bMD5\b|\bHMAC\b|\bMAC\b|\bCRC32?\b|Merkle[- ]Damgard",
    ),
    PatternRule(
        "classic cipher",
        "Classic",
        r"\bVigen[eè]re\b|\bCaesar\b|\bsubstitution\b|\bPolybius\b|\bXOR\b",
    ),
    PatternRule(
        "secret sharing",
        "SecretSharing",
        r"\bShamir\b|secret\s+sharing|Lagrange\s+interpolation",
    ),
    PatternRule(
        "zero knowledge", "ZKP", r"\bZKP\b|zero[- ]knowledge|Groth16|SNARK|KZG"
    ),
)

ANTI_NOISE_RE = re.compile(
    r"\b(?:xss|sqli|sql\s+injection|ssti|csrf|ssrf|deserialization|rop|heap|pwn|reverse\s+engineering|forensics|stego|pcap|docker|kubernetes)\b",
    re.IGNORECASE,
)

CODE_CRYPTO_RE = re.compile(
    r"\b(?:Crypto\.Util|Crypto\.Cipher|long_to_bytes|bytes_to_long|inverse\s*\(|GCD\s*\(|gcd\s*\(|Zmod\s*\(|GF\s*\(|PolynomialRing|small_roots?\s*\(|Matrix\s*\(|EllipticCurve|discrete_log|pow\s*\([^\n]{0,80},\s*[^\n]{0,30},\s*[^\n]{0,30}\))",
    re.IGNORECASE,
)


def classify_crypto(text: str, *, min_score: float = 2.4) -> GateResult:
    """Return the strong-gate decision for a candidate chunk.

    The v1 gate is intentionally conservative: a plain category label such as
    "crypto" is not enough.  A record must contain a recognizable primitive plus
    an attack path, or strong code-level crypto evidence plus an attack path.
    """

    body = text or ""
    primitive_hits: list[str] = []
    crypto_types: list[str] = []
    attack_hits: list[str] = []
    attack_patterns: list[str] = []
    score = 0.0

    for rule in PRIMITIVE_RULES:
        if re.search(rule.regex, body, re.IGNORECASE):
            primitive_hits.append(rule.label)
            crypto_types.append(rule.crypto_type)
            score += 0.8 * rule.weight

    for rule in ATTACK_RULES:
        if re.search(rule.regex, body, re.IGNORECASE):
            attack_hits.append(rule.label)
            attack_patterns.append(rule.label)
            crypto_types.append(rule.crypto_type)
            score += rule.weight

    code_crypto = bool(CODE_CRYPTO_RE.search(body))
    if code_crypto:
        score += 0.8

    noise = bool(ANTI_NOISE_RE.search(body))
    if noise and not attack_hits:
        score -= 1.5

    reasons = []
    if primitive_hits:
        reasons.append("primitive-hit")
    if attack_hits:
        reasons.append("attack-pattern-hit")
    if code_crypto:
        reasons.append("crypto-code-hit")
    if noise:
        reasons.append("non-crypto-noise-hit")

    # Strong gate: attack pattern is required unless the code evidence is very
    # explicit and there are multiple primitives.  This keeps generic writeups,
    # web tasks with a token hash, or pages merely tagged "crypto" out of v1.
    keep = bool(attack_hits and (primitive_hits or code_crypto) and score >= min_score)
    if (
        not keep
        and code_crypto
        and len(set(primitive_hits)) >= 2
        and score >= min_score + 0.8
    ):
        keep = True

    return GateResult(
        keep=keep,
        score=round(score, 3),
        crypto_type=_dedupe(crypto_types),
        attack_pattern=_dedupe(attack_patterns),
        primitive_hits=_dedupe(primitive_hits),
        attack_hits=_dedupe(attack_hits),
        reasons=reasons,
    )


PWN_PRIMITIVE_RULES: tuple[PatternRule, ...] = (
    PatternRule("glibc allocator", "glibc heap", r"\b(?:glibc|ptmalloc|malloc|free|calloc|realloc|main_arena)\b"),
    PatternRule("heap chunk metadata", "heap", r"\b(?:heap|chunk|tcache|fastbin|smallbin|largebin|unsorted bin|top chunk)\b"),
    PatternRule("ELF mitigation", "binary exploitation", r"\b(?:PIE|RELRO|NX|canary|ASLR|GOT|PLT|libc)\b"),
)

PWN_ATTACK_RULES: tuple[PatternRule, ...] = (
    PatternRule("tcache poisoning", "glibc heap", r"\btcache\b[\s\S]{0,100}\b(?:poison|dup|double.?free|freelist|next)\b", 2.8),
    PatternRule("fastbin dup", "glibc heap", r"\bfastbin\b[\s\S]{0,100}\b(?:dup|double.?free|poison|freelist)\b", 2.6),
    PatternRule("unsorted bin attack", "glibc heap", r"\bunsorted bin\b[\s\S]{0,100}\b(?:attack|leak|bk|fd|main_arena)\b", 2.6),
    PatternRule("use after free", "heap", r"\b(?:use.after.free|UAF)\b", 2.4),
    PatternRule("double free", "heap", r"\bdouble.?free\b", 2.3),
    PatternRule("heap overflow", "heap", r"\b(?:heap overflow|off.by.one|null.byte overflow|chunk overlap)\b", 2.3),
    PatternRule("house of force", "glibc heap", r"\bhouse of force\b", 2.8),
    PatternRule("house of spirit", "glibc heap", r"\bhouse of spirit\b", 2.8),
    PatternRule("house of orange", "glibc heap", r"\bhouse of orange\b", 2.8),
    PatternRule("safe linking bypass", "glibc heap", r"\b(?:safe.?linking|pointer mangling)\b", 2.6),
    PatternRule("libc address leak", "binary exploitation", r"\b(?:libc|main_arena|GOT)\b[\s\S]{0,100}\b(?:leak|address disclosure)\b", 2.0),
    PatternRule("malloc hook hijack", "glibc heap", r"\b__(?:malloc|free)_hook\b|\bmalloc hook\b|\bfree hook\b", 2.6),
)


def classify_pwn(text: str, *, min_score: float = 2.4) -> GateResult:
    """Return the strong-gate decision for glibc heap/binary exploitation text."""

    body = text or ""
    primitive_hits: list[str] = []
    pwn_types: list[str] = []
    attack_hits: list[str] = []
    attack_patterns: list[str] = []
    score = 0.0
    for rule in PWN_PRIMITIVE_RULES:
        if re.search(rule.regex, body, re.IGNORECASE):
            primitive_hits.append(rule.label)
            pwn_types.append(rule.crypto_type)
            score += 0.8 * rule.weight
    for rule in PWN_ATTACK_RULES:
        if re.search(rule.regex, body, re.IGNORECASE):
            attack_hits.append(rule.label)
            attack_patterns.append(rule.label)
            pwn_types.append(rule.crypto_type)
            score += rule.weight
    reasons = []
    if primitive_hits:
        reasons.append("primitive-hit")
    if attack_hits:
        reasons.append("attack-pattern-hit")
    return GateResult(
        keep=bool(attack_hits and primitive_hits and score >= min_score),
        score=round(score, 3),
        crypto_type=_dedupe(pwn_types),
        attack_pattern=_dedupe(attack_patterns),
        primitive_hits=_dedupe(primitive_hits),
        attack_hits=_dedupe(attack_hits),
        reasons=reasons,
    )


def classify_category(text: str, *, category: str = "crypto", min_score: float = 2.4) -> GateResult:
    """Dispatch a category-specific strong gate while retaining the v1 schema."""

    if category.strip().lower() == "pwn":
        return classify_pwn(text, min_score=min_score)
    return classify_crypto(text, min_score=min_score)


def _dedupe(items: list[str]) -> list[str]:
    seen = set()
    out = []
    for item in items:
        value = str(item or "").strip()
        if not value:
            continue
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out
