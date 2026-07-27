from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import random
import threading
import time
import tkinter as tk
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import uuid4

BILLING = [
    ("0190", "J00", 550.0, "CONSULTATION"),
    ("0191", "I10", 480.0, "CONSULTATION"),
    ("3604", "Z01.7", 320.0, "PATHOLOGY"),
    ("3700", "R05", 980.0, "RADIOLOGY"),
    ("0051", "R07.9", 1250.0, "DIAGNOSTIC"),
]


def tokenise(value: str, key: str, purpose: str, length: int = 32) -> str:
    digest = hmac.new(
        key.encode("utf-8"),
        f"{purpose}:{value.strip()}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return digest[:length]


def http_json(url: str, *, token: str, method: str = "GET", payload=None, timeout=30):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-request-id": str(uuid4()),
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"message": raw[:500]}
        return error.code, parsed


@dataclass(frozen=True)
class SchemeProfile:
    slug: str
    scheme_id: str
    scheme_name: str
    source: str
    api_url: str
    token_env: str
    tokenisation_key_env: str
    interval_seconds: int
    claims_per_batch: int
    members: list[dict]
    providers: list[dict]

    @classmethod
    def from_dict(cls, value: dict) -> "SchemeProfile":
        scheme_id = str(value["scheme_id"]).strip()
        if not scheme_id or len(scheme_id) > 8:
            raise ValueError("scheme_id must contain 1 to 8 characters for the current ClaimGuard database contract.")
        return cls(
            slug=str(value["slug"]).strip(),
            scheme_id=scheme_id,
            scheme_name=str(value["scheme_name"]).strip(),
            source=str(value.get("source") or f"{value['slug']}-claims-server").strip(),
            api_url=str(value["api_url"]).rstrip("/"),
            token_env=str(value["token_env"]).strip(),
            tokenisation_key_env=str(value["tokenisation_key_env"]).strip(),
            interval_seconds=max(5, int(value.get("interval_seconds", 30))),
            claims_per_batch=max(1, min(500, int(value.get("claims_per_batch", 5)))),
            members=list(value["members"]),
            providers=list(value["providers"]),
        )

    def credentials(self) -> tuple[str, str]:
        token = os.environ.get(self.token_env, "").strip()
        key = os.environ.get(self.tokenisation_key_env, "").strip()
        if not token:
            raise RuntimeError(f"Missing Windows environment variable {self.token_env}.")
        if len(key) < 16:
            raise RuntimeError(f"{self.tokenisation_key_env} must contain at least 16 characters.")
        return token, key


def load_profiles(path: Path) -> list[SchemeProfile]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    schemes = payload.get("schemes") if isinstance(payload, dict) else None
    if not isinstance(schemes, list) or not schemes:
        raise ValueError("Configuration must contain a non-empty schemes array.")
    profiles = [SchemeProfile.from_dict(item) for item in schemes]
    if len({item.slug for item in profiles}) != len(profiles):
        raise ValueError("Scheme slugs must be unique.")
    return profiles


def private_member(member: dict, profile: SchemeProfile, key: str) -> dict:
    return {
        **member,
        "scheme_id": profile.scheme_id,
        "member_id": tokenise(str(member["member_id"]), key, "ID"),
        "first_name": tokenise(str(member["first_name"]), key, "NAME", 64),
        "last_name": tokenise(str(member["last_name"]), key, "NAME", 64),
        "identity_number": tokenise(str(member["identity_number"]), key, "ID", 64),
        "banking_detail": tokenise(str(member["banking_detail"]), key, "BANK", 64),
        "date_of_birth": f"{str(member['date_of_birth'])[:4]}-01-01",
        "home_lat": round(float(member["home_lat"]), 1),
        "home_lon": round(float(member["home_lon"]), 1),
    }


def private_provider(provider: dict, profile: SchemeProfile, key: str) -> dict:
    return {
        **provider,
        "scheme_id": profile.scheme_id,
        "provider_id": tokenise(str(provider["provider_id"]), key, "ID"),
        "practice_number": tokenise(str(provider["practice_number"]), key, "PCNS", 32),
        "practice_name": tokenise(str(provider["practice_name"]), key, "NAME", 64),
        "banking_detail": tokenise(str(provider["banking_detail"]), key, "BANK", 64),
        "practice_lat": round(float(provider["practice_lat"]), 1),
        "practice_lon": round(float(provider["practice_lon"]), 1),
        "provider_kind": str(provider.get("provider_kind") or "PRACTICE"),
        "provider_category": str(provider.get("provider_category") or provider["specialty"]),
    }


def build_batch(profile: SchemeProfile, batch_number: int) -> tuple[dict, list[str]]:
    _, key = profile.credentials()
    members = [private_member(item, profile, key) for item in profile.members]
    providers = [private_provider(item, profile, key) for item in profile.providers]
    claims = []
    claim_ids = []
    for index in range(profile.claims_per_batch):
        member = random.choice(profile.members)
        provider = random.choice(profile.providers)
        billing_code, diagnosis, baseline, line_type = random.choice(BILLING)
        service_date = date.today() - timedelta(days=random.randint(0, 30))
        received_date = service_date + timedelta(days=random.randint(0, 3))
        raw_claim_id = f"{profile.slug[:4].upper()}-{batch_number:06d}-{index:03d}"
        claim_id = tokenise(raw_claim_id, key, "ID")
        claim_ids.append(claim_id)
        claims.append({
            "claim_id": claim_id,
            "scheme_id": profile.scheme_id,
            "member_id": tokenise(str(member["member_id"]), key, "ID"),
            "provider_id": tokenise(str(provider["provider_id"]), key, "ID"),
            "service_date": service_date.isoformat(),
            "received_date": received_date.isoformat(),
            "billing_code": billing_code,
            "amount": round(baseline * random.uniform(0.7, 3.5), 2),
            "quantity": 1.0,
            "benefit_option": random.choice(["STANDARD", "COMPREHENSIVE", "SAVER"]),
            "network_type": random.choice(["IN_NETWORK", "OUT_OF_NETWORK"]),
            "line_type": line_type,
            "tariff_discipline": str(provider.get("specialty") or "GENERAL"),
            "diagnosis_code": diagnosis,
            "rendering_practitioner_id": None,
            "rendering_practitioner_category": "NONE",
            "rendering_known_to_billing_provider": False,
        })
    return {
        "source": profile.source,
        "schemes": [{"scheme_id": profile.scheme_id, "scheme_name": profile.scheme_name}],
        "members": members,
        "providers": providers,
        "claims": claims,
    }, claim_ids


def submit_once(profile: SchemeProfile, batch_number: int) -> tuple[int, dict, list[str]]:
    token, _ = profile.credentials()
    payload, claim_ids = build_batch(profile, batch_number)
    status, response = http_json(
        f"{profile.api_url}/claims/ingest",
        token=token,
        method="POST",
        payload=payload,
        timeout=60,
    )
    return status, response, claim_ids


def poll_claim(profile: SchemeProfile, claim_id: str, timeout_seconds: int = 120):
    token, _ = profile.credentials()
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        status, response = http_json(
            f"{profile.api_url}/claims/{quote(claim_id, safe='')}",
            token=token,
        )
        claim = response.get("claim") if status == 200 else None
        if claim and claim.get("processingStatus") in {"scored", "failed"}:
            return claim
        time.sleep(2)
    return None


class SimulatorApp(tk.Tk):
    def __init__(self, config_path: Path):
        super().__init__()
        self.title("ClaimGuard Scheme Simulator")
        self.geometry("1050x650")
        self.config_path = config_path
        self.profiles = load_profiles(config_path)
        self.running: dict[str, threading.Event] = {}
        self.batch_numbers = {profile.slug: 1 for profile in self.profiles}
        self._build()

    def _build(self):
        toolbar = ttk.Frame(self, padding=10)
        toolbar.pack(fill="x")
        ttk.Label(toolbar, text=f"Configuration: {self.config_path}").pack(side="left")
        ttk.Button(toolbar, text="Open configuration", command=self._choose_config).pack(side="right")

        self.tree = ttk.Treeview(
            self,
            columns=("scheme", "server", "interval", "status", "last"),
            show="headings",
            height=12,
        )
        for column, title, width in [
            ("scheme", "Medical scheme", 230),
            ("server", "Claims server", 230),
            ("interval", "Interval", 90),
            ("status", "Status", 120),
            ("last", "Latest result", 320),
        ]:
            self.tree.heading(column, text=title)
            self.tree.column(column, width=width)
        self.tree.pack(fill="x", padx=10)
        for profile in self.profiles:
            self.tree.insert("", "end", iid=profile.slug, values=(
                profile.scheme_name,
                profile.source,
                f"{profile.interval_seconds}s",
                "Stopped",
                "—",
            ))

        controls = ttk.Frame(self, padding=10)
        controls.pack(fill="x")
        ttk.Button(controls, text="Submit one batch", command=self._submit_selected).pack(side="left")
        ttk.Button(controls, text="Start selected", command=self._start_selected).pack(side="left", padx=8)
        ttk.Button(controls, text="Stop selected", command=self._stop_selected).pack(side="left")
        ttk.Button(controls, text="Start all", command=self._start_all).pack(side="left", padx=8)
        ttk.Button(controls, text="Stop all", command=self._stop_all).pack(side="left")

        self.log = tk.Text(self, height=20, state="disabled", wrap="word")
        self.log.pack(fill="both", expand=True, padx=10, pady=(0, 10))

    def _selected(self):
        selected = self.tree.selection()
        if not selected:
            messagebox.showinfo("ClaimGuard", "Select a medical scheme first.")
            return None
        return next(item for item in self.profiles if item.slug == selected[0])

    def _write(self, text: str):
        self.after(0, lambda: self._append(text))

    def _append(self, text: str):
        self.log.configure(state="normal")
        self.log.insert("end", f"[{time.strftime('%H:%M:%S')}] {text}\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _set_row(self, profile: SchemeProfile, status: str, latest: str):
        self.after(0, lambda: self.tree.item(profile.slug, values=(
            profile.scheme_name,
            profile.source,
            f"{profile.interval_seconds}s",
            status,
            latest,
        )))

    def _submit(self, profile: SchemeProfile):
        batch = self.batch_numbers[profile.slug]
        try:
            self._set_row(profile, "Submitting", f"Batch {batch}")
            status, response, claim_ids = submit_once(profile, batch)
            if status == 202:
                self.batch_numbers[profile.slug] += 1
                self._write(f"{profile.scheme_name}: batch {batch} accepted; waiting for automatic scoring.")
                self._set_row(profile, "Accepted", f"HTTP 202 · {len(claim_ids)} claims")
                claim = poll_claim(profile, claim_ids[0])
                if claim:
                    result = f"{claim.get('processingStatus')} · risk {claim.get('riskScore')}"
                    self._set_row(profile, "Running", result)
                    self._write(f"{profile.scheme_name}: first claim {result}.")
                else:
                    self._set_row(profile, "Running", "Scoring status timed out")
            elif status == 503 and response.get("committed") is True:
                self._set_row(profile, "Retry needed", "Committed; wake-up unavailable")
                self._write(f"{profile.scheme_name}: ClaimGuard committed batch {batch}, but scoring wake-up failed. Retry the identical batch.")
            else:
                self._set_row(profile, "Error", f"HTTP {status}: {response.get('code') or response.get('message')}")
                self._write(f"{profile.scheme_name}: submission failed with HTTP {status}: {response}")
        except (RuntimeError, ValueError, URLError, OSError) as error:
            self._set_row(profile, "Error", str(error))
            self._write(f"{profile.scheme_name}: {error}")

    def _run_loop(self, profile: SchemeProfile, stop: threading.Event):
        while not stop.is_set():
            self._submit(profile)
            stop.wait(profile.interval_seconds)
        self._set_row(profile, "Stopped", "—")

    def _submit_selected(self):
        profile = self._selected()
        if profile:
            threading.Thread(target=self._submit, args=(profile,), daemon=True).start()

    def _start(self, profile: SchemeProfile):
        if profile.slug in self.running and not self.running[profile.slug].is_set():
            return
        stop = threading.Event()
        self.running[profile.slug] = stop
        self._set_row(profile, "Starting", "—")
        threading.Thread(target=self._run_loop, args=(profile, stop), daemon=True).start()

    def _start_selected(self):
        profile = self._selected()
        if profile:
            self._start(profile)

    def _stop_selected(self):
        profile = self._selected()
        if profile and profile.slug in self.running:
            self.running[profile.slug].set()

    def _start_all(self):
        for profile in self.profiles:
            self._start(profile)

    def _stop_all(self):
        for event in self.running.values():
            event.set()

    def _choose_config(self):
        filename = filedialog.askopenfilename(filetypes=[("JSON configuration", "*.json")])
        if filename:
            messagebox.showinfo("ClaimGuard", "Restart the application with the selected configuration file.")


def main() -> int:
    parser = argparse.ArgumentParser(description="ClaimGuard Windows medical-scheme server simulator")
    parser.add_argument("--config", type=Path, default=Path("schemes.json"))
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--scheme", default="all")
    args = parser.parse_args()
    profiles = load_profiles(args.config)
    if args.headless:
        selected = profiles if args.scheme == "all" else [item for item in profiles if item.slug == args.scheme]
        if not selected:
            raise SystemExit(f"Unknown scheme: {args.scheme}")
        for profile in selected:
            status, response, _ = submit_once(profile, 1)
            print(json.dumps({"scheme": profile.slug, "status": status, "response": response}, default=str))
        return 0
    SimulatorApp(args.config).mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
