import React, { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Menu from "lucide-react/dist/esm/icons/menu.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { useRole } from "../../context/RoleContext";
import { NAV_GROUPS } from "../../lib/roleNav";
import { RoleSwitcher } from "./RoleSwitcher";

function formatRole(role) {
  if (!role) return "Unknown";
  return role
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function isLiveDetectionRoute(pathname) {
  return (
    pathname === "/" ||
    pathname.startsWith("/claims") ||
    pathname === "/network" ||
    pathname === "/risk" ||
    pathname === "/history"
  );
}

export function InvestigatorLayout({
  liveRefreshEnabled,
  setLiveRefreshEnabled,
  refreshNow,
  lastRefresh,
  ledgerStatus,
  dataSource,
}) {
  const { identity, logout, mode } = useRole();
  const location = useLocation();
  const visibleNavGroups = useMemo(
    () =>
      NAV_GROUPS
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => item.roles.includes(identity.role)),
        }))
        .filter((group) => group.items.length > 0),
    [identity.role],
  );
  const showLiveControls = isLiveDetectionRoute(location.pathname);

  const [theme, setTheme] = useState(() => window.localStorage.getItem("claimguard-theme") || "dark");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    window.localStorage.setItem("claimguard-theme", theme);
  }, [theme]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border-soft bg-surface-elevated px-4 py-3 lg:hidden">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-10 w-10 rounded-lg text-muted-2 hover:text-foreground"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary border border-border-soft">
            <Activity className="h-4 w-4" />
          </span>
          <p className="font-data text-xs uppercase tracking-[0.2em] text-muted">Investigator console</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 w-10 rounded-full text-muted-2 hover:text-foreground"
          onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
          aria-label="Toggle theme on mobile"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>

      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-30 bg-background/80 backdrop-blur-sm lg:hidden"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <div className="mx-auto grid min-h-screen w-full max-w-[1680px] grid-cols-1 lg:grid-cols-[260px_1fr]">
        <aside
          className={[
            "fixed inset-y-0 left-0 z-40 flex h-screen w-[260px] flex-col overflow-y-auto border-r border-border-soft bg-surface-elevated px-4 py-5 transition-transform duration-200 investigator-scrollbar",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
            "lg:sticky lg:top-0 lg:z-auto lg:w-auto lg:translate-x-0",
          ].join(" ")}
        >
          <div className="mb-6 flex items-center justify-between gap-3">
            <Link to="/" className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary border border-border-soft shadow-inner">
                <Activity className="h-5 w-5" />
              </span>
              <div>
                <p className="font-display text-[15px] font-semibold tracking-tight leading-none text-foreground">ClaimGuard</p>
                <p className="font-data text-[9px] uppercase tracking-[0.2em] text-muted-2 mt-1">Investigator console</p>
              </div>
            </Link>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 rounded-full hidden lg:inline-flex text-muted-2 hover:text-foreground hover:bg-white/5"
                onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 rounded-full lg:hidden text-muted-2 hover:text-foreground"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close navigation"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <nav className="space-y-6">
            {visibleNavGroups.map((group, groupIndex) => (
              <section
                key={group.key}
                className={groupIndex > 0 ? "border-t border-border-soft/50 pt-5" : ""}
                aria-label={group.title}
              >
                <div className="px-2 pb-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">{group.title}</p>
                </div>
                <div className="space-y-1">
                  {group.items.map((item, itemIndex) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === "/"}
                      className={({ isActive }) =>
                        [
                          "group flex items-center gap-3 rounded-[10px] px-2 py-2 text-[13px] font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary",
                          isActive
                            ? "bg-primary/10 text-primary shadow-[inset_2px_0_0_0_currentColor]"
                            : "text-muted hover:bg-white/5 hover:text-foreground",
                        ].join(" ")
                      }
                    >
                      <span className="font-data flex h-7 w-7 items-center justify-center rounded-lg bg-black/20 text-[10px] text-muted group-[.active]:text-primary group-[.active]:bg-primary/20">
                        {String(itemIndex + 1).padStart(2, "0")}
                      </span>
                      <span className="flex-1">{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              </section>
            ))}
          </nav>

          <div className="mt-auto space-y-4 pt-6 border-t border-border-soft/50">
            <RoleSwitcher />
            {mode === "session" ? (
              <div className="rounded-[12px] border border-border-soft bg-surface-card p-3 shadow-sm">
                <p className="text-[13px] font-semibold text-foreground">{identity.label}</p>
                <p className="text-[11px] text-muted-2 mt-0.5">{identity.tenantLabel}</p>
                <Button type="button" variant="outline" size="sm" className="mt-3 w-full h-8 text-xs border-border-soft bg-white/5 hover:bg-white/10 hover:text-foreground text-muted" onClick={logout}>Sign out</Button>
              </div>
            ) : null}
          </div>
        </aside>

        <main className="min-w-0 p-4 md:p-6 xl:p-8">
          <header className="mb-6 flex flex-col gap-4 rounded-[14px] border border-border-soft bg-surface-elevated px-4 py-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-border-soft bg-black/20 px-3 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-[#71a8d9]" aria-hidden="true" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Tenant:</span>
                <span className="text-[11px] font-semibold text-foreground">{identity.tenantLabel || identity.tenantId}</span>
              </div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-border-soft bg-black/20 px-3 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Role:</span>
                <span className="text-[11px] font-semibold text-foreground">{formatRole(identity.role)}</span>
              </div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-border-soft bg-black/20 px-3 py-1">
                <Activity className="h-3 w-3 text-[#62ce9b]" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
                  {mode === "session" ? "Authenticated" : "Demo Mode"}
                </span>
              </div>
            </div>
            {showLiveControls ? (
              <div className="flex flex-wrap items-center gap-2.5 lg:justify-end">
                <div className={`inline-flex items-center gap-1.5 rounded-full border border-border-soft bg-black/20 px-3 py-1 ${ledgerStatus === "Connected" ? "text-[#62ce9b]" : "text-[#e6a74d]"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${ledgerStatus === "Connected" ? "bg-[#62ce9b]" : "bg-[#e6a74d]"}`} aria-hidden="true" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Ledger:</span>
                  <span className="text-[11px] font-semibold">{ledgerStatus}</span>
                </div>
                <div className="inline-flex rounded-full border border-border-soft bg-black/20 p-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLiveRefreshEnabled(true)}
                    aria-label="Enable live refresh"
                    className={`h-7 rounded-full px-3 text-[11px] font-semibold hover:bg-transparent ${liveRefreshEnabled ? "bg-primary/20 text-primary border border-primary/30" : "text-muted hover:text-foreground"}`}
                  >
                    Live Refresh
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLiveRefreshEnabled(false)}
                    aria-label="Disable live refresh"
                    className={`h-7 rounded-full px-3 text-[11px] font-semibold hover:bg-transparent ${!liveRefreshEnabled ? "bg-white/10 text-foreground border border-border-soft" : "text-muted hover:text-foreground"}`}
                  >
                    Paused
                  </Button>
                </div>
                <Button size="sm" variant="outline" onClick={refreshNow} className="h-8 rounded-full px-4 text-xs border-border-soft bg-white/5 hover:bg-white/10 text-foreground">
                  Refresh
                </Button>
              </div>
            ) : null}
          </header>

          <Outlet />
        </main>
      </div>
    </div>
  );
}
