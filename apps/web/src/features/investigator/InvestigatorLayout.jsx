import React, { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { Activity, ChartSpline, Clock3, Home, Moon, Network, Search, Sun, TriangleAlert } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";

const navItems = [
  { to: "/", label: "Dashboard", icon: Home },
  { to: "/claims", label: "Claims Explorer", icon: Search },
  { to: "/network", label: "Network Graph", icon: Network },
  { to: "/risk", label: "Risk Panel", icon: TriangleAlert },
  { to: "/history", label: "Detection History", icon: Clock3 },
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
      <div className="mx-auto grid min-h-screen w-full max-w-[1600px] grid-cols-1 lg:grid-cols-[260px_1fr]">
        <aside className="border-b border-border bg-card/70 p-4 backdrop-blur lg:border-b-0 lg:border-r">
          <div className="mb-6 flex items-center justify-between">
            <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
              <Activity className="h-4 w-4 text-primary" />
              ClaimGuard Investigator
            </Link>
            <Button variant="ghost" size="sm" onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}>
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>

          <nav className="space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    [
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                      isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    ].join(" ")
                  }
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>

          <div className="mt-6 rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
            <div className="mb-2 flex items-center justify-between">
              <span>Ledger status</span>
              <Badge variant={ledgerStatus === "Connected" ? "success" : "warning"}>{ledgerStatus}</Badge>
            </div>
            <p className="text-[11px]">Last refresh: {lastRefresh ? new Date(lastRefresh).toLocaleString() : "waiting"}</p>
          </div>
        </aside>

        <main className="p-4 md:p-6">
          <header className="mb-4 flex flex-col gap-3 rounded-xl border border-border bg-card p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-lg font-semibold">Fraud Investigator Workspace</h1>
              <p className="text-sm text-muted-foreground">Monitor detections, inspect claims, and trace relationship networks.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="gap-1">
                <ChartSpline className="h-3 w-3" />
                Demo mode
              </Badge>
              <div className="inline-flex rounded-md border border-border bg-background p-1">
                <Button
                  size="sm"
                  variant={mode === "live" ? "default" : "ghost"}
                  onClick={() => setMode("live")}
                  aria-label="Enable live replay"
                >
                  Live Replay
                </Button>
                <Button
                  size="sm"
                  variant={mode === "static" ? "default" : "ghost"}
                  onClick={() => setMode("static")}
                  aria-label="Enable static snapshot"
                >
                  Static Snapshot
                </Button>
              </div>
              <Button size="sm" variant="outline" onClick={refreshNow}>Refresh now</Button>
            </div>
          </header>

          <Outlet />
        </main>
      </div>
    </div>
  );
}
