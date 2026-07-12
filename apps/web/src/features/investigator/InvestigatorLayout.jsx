import React, { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { Activity, Moon, ShieldCheck, Sparkles, Sun } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";

const navItems = [
  { to: "/", label: "Dashboard" },
  { to: "/claims", label: "Claims Explorer" },
  { to: "/network", label: "Network Graph" },
  { to: "/risk", label: "Risk Panel" },
  { to: "/history", label: "Detection History" },
];

export function InvestigatorLayout({ mode, setMode, refreshNow, lastRefresh, ledgerStatus }) {
  const [theme, setTheme] = useState(() => window.localStorage.getItem("claimguard-theme") || "dark");

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    window.localStorage.setItem("claimguard-theme", theme);
  }, [theme]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto grid min-h-screen w-full max-w-[1680px] grid-cols-1 lg:grid-cols-[300px_1fr]">
        <aside className="sticky top-0 flex h-screen flex-col border-b border-border bg-card px-4 py-4 lg:border-b-0 lg:border-r">
          <div className="mb-5 flex items-center justify-between gap-3 border-b border-border/70 pb-4">
            <Link to="/" className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Activity className="h-5 w-5" />
              </span>
              <div>
                <p className="font-display text-sm font-semibold tracking-tight">ClaimGuard</p>
                <p className="font-data text-xs uppercase tracking-[0.2em] text-muted-foreground">Investigator console</p>
              </div>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              className="h-10 w-10 rounded-full"
              onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>

          <div className="mb-5 space-y-3 rounded-2xl border border-border/70 bg-background/80 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Connection</p>
                <p className="mt-1 text-sm font-medium text-foreground">{ledgerStatus === "Connected" ? "Ledger linked" : "Ledger unavailable"}</p>
              </div>
              <Badge variant={ledgerStatus === "Connected" ? "success" : "warning"} className="rounded-full px-2.5 py-1 text-[11px]">
                {ledgerStatus}
              </Badge>
            </div>
            <div className="rounded-xl border border-border/70 bg-card p-3 text-xs text-muted-foreground">
              <div className="mb-1 flex items-center gap-2 text-foreground">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <span className="font-medium">Last refresh</span>
              </div>
              <p className="font-data">{lastRefresh ? new Date(lastRefresh).toLocaleString() : "waiting for first sync"}</p>
            </div>
          </div>

          <nav className="space-y-1.5">
            <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Case file sections</p>
            {navItems.map((item, index) => {
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    [
                      "group flex items-center gap-3 rounded-lg border-l-2 px-3 py-3 text-sm font-medium transition-all",
                      isActive
                        ? "border-primary bg-secondary/60 text-foreground"
                        : "border-transparent text-muted-foreground hover:border-border hover:bg-secondary/30 hover:text-foreground",
                    ].join(" ")
                  }
                >
                  <span className="font-data flex h-9 w-9 items-center justify-center rounded-lg bg-background/70 text-[11px] text-muted-foreground group-[.active]:border-primary/40 group-[.active]:text-primary">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="flex-1">{item.label}</span>
                </NavLink>
              );
            })}
          </nav>

          <div className="mt-auto pt-4">
            <div className="rounded-xl border border-border/70 bg-card p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                <Sparkles className="h-4 w-4 text-primary" />
                Demo mode
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Use Live Replay for streaming refreshes or Static Snapshot for a fixed case review.</p>
            </div>
          </div>
        </aside>

        <main className="min-w-0 p-4 md:p-6 xl:p-8">
          <header className="mb-6 flex flex-col gap-4 rounded-xl border border-border/70 bg-card px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Fraud investigation workspace</p>
              <h1 className="text-xl font-semibold tracking-tight">Operational review console</h1>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">Monitor detections, inspect claims, and trace relationship networks across the current investigator snapshot.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <Badge variant="outline" className="gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em]">
                <Activity className="h-3.5 w-3.5" />
                Demo mode
              </Badge>
              <div className="inline-flex rounded-full border border-border bg-background p-1">
                <Button
                  size="sm"
                  variant={mode === "live" ? "default" : "ghost"}
                  onClick={() => setMode("live")}
                  aria-label="Enable live replay"
                  className="rounded-full px-4"
                >
                  Live Replay
                </Button>
                <Button
                  size="sm"
                  variant={mode === "static" ? "default" : "ghost"}
                  onClick={() => setMode("static")}
                  aria-label="Enable static snapshot"
                  className="rounded-full px-4"
                >
                  Static Snapshot
                </Button>
              </div>
              <Button size="sm" variant="outline" onClick={refreshNow} className="rounded-full px-4">
                Refresh now
              </Button>
            </div>
          </header>

          <Outlet />
        </main>
      </div>
    </div>
  );
}
