import React, { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import LogOut from "lucide-react/dist/esm/icons/log-out.mjs";
import UserRound from "lucide-react/dist/esm/icons/user-round.mjs";
import { Button } from "../../components/ui/button";

export function initialsFromLabel(label) {
  const words = String(label || "Account")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "CG";
}

export function compactAccountName(label) {
  const words = String(label || "Account")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2) return words[0] || "Account";
  return `${words[0][0]?.toUpperCase()}. ${words.at(-1)}`;
}

export function AccountMenu({ identity, roleLabel, onLogout, compact = false }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef(null);
  const location = useLocation();
  const label = identity?.label || "Authenticated account";
  const initials = initialsFromLabel(label);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnPointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <Button
        type="button"
        variant="ghost"
        className={`h-auto min-h-10 gap-2 rounded-lg px-1.5 py-1 text-left ${compact ? "w-11 justify-center" : "justify-start"}`}
        aria-label={`Open account menu for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/12 text-xs font-semibold text-primary">
          {initials}
        </span>
        {!compact ? (
          <>
            <span className="hidden min-w-0 lg:block">
              <span className="block max-w-[130px] truncate text-xs font-semibold text-foreground xl:max-w-[150px]">
                {compactAccountName(label)}
              </span>
              <span className="mt-0.5 block max-w-[150px] truncate text-[10px] text-muted-foreground">
                {roleLabel}
              </span>
            </span>
            <ChevronDown
              className={`hidden h-3.5 w-3.5 text-muted-foreground transition-transform lg:block ${open ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </>
        ) : null}
      </Button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-64 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
        >
          <div className="border-b border-border px-4 py-3">
            <p className="truncate text-sm font-semibold">{label}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{roleLabel}</p>
          </div>
          <div className="p-1.5">
            <Link
              to="/profile"
              role="menuitem"
              className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:bg-muted"
            >
              <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Profile
            </Link>
            <button
              type="button"
              role="menuitem"
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10"
              onClick={onLogout}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
