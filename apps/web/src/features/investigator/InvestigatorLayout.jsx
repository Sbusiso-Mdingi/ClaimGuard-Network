import React, { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Menu from "lucide-react/dist/esm/icons/menu.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
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
  simulatorState,
  sendSimulatorCommand,
  refreshNow,
  lastRefresh,
  ledgerStatus,
  dataSource,
}) {
  const { identity } = useRole();
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
  const usingDemoDataset = dataSource === "demo";
  const simulator = simulatorState?.simulator || null;
  const canControlSimulator = identity.role === "platform_administrator";

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
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 lg:hidden">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-10 w-10 rounded-lg"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Activity className="h-4 w-4" />
          </span>
          <p className="font-data text-xs uppercase tracking-[0.2em] text-muted-foreground">Investigator console</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 w-10 rounded-full"
          onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
          aria-label="Toggle theme on mobile"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>

      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-30 bg-background/70 backdrop-blur-sm lg:hidden"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <div className="mx-auto grid min-h-screen w-full max-w-[1680px] grid-cols-1 lg:grid-cols-[300px_1fr]">
        <aside
          className={[
            "fixed inset-y-0 left-0 z-40 flex h-screen w-[300px] flex-col overflow-y-auto border-r border-border bg-card px-4 py-4 transition-transform duration-200 investigator-scrollbar",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
            "lg:sticky lg:top-0 lg:z-auto lg:w-auto lg:translate-x-0",
          ].join(" ")}
        >
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
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-10 w-10 rounded-full"
                onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-10 w-10 rounded-full lg:hidden"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close navigation"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <nav className="space-y-5">
            {visibleNavGroups.map((group, groupIndex) => (
              <section
                key={group.key}
                className={groupIndex > 0 ? "border-t border-border/70 pt-5" : ""}
                aria-label={group.title}
              >
                <div className="px-3 pb-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{group.title}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{group.subtitle}</p>
                </div>
                <div className="space-y-1.5">
                  {group.items.map((item, itemIndex) => (
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
                        {String(itemIndex + 1).padStart(2, "0")}
                      </span>
                      <span className="flex-1">{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              </section>
            ))}
          </nav>

          <div className="mt-auto pt-4">
            <RoleSwitcher />
          </div>
        </aside>

        <main className="min-w-0 p-4 md:p-6 xl:p-8">
          <header className="mb-6 flex flex-col gap-4 rounded-xl border border-border/70 bg-card px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em]">
                Tenant: {identity.tenantLabel || identity.tenantId}
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em]">
                Role: {formatRole(identity.role)}
              </Badge>
              <Badge variant="outline" className="gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em]">
                <Activity className="h-3.5 w-3.5" />
                Demo Mode
              </Badge>
              {usingDemoDataset ? (
                <Badge variant="warning" className="gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em]">
                  <Sparkles className="h-3.5 w-3.5" />
                  Demo Dataset
                </Badge>
              ) : null}
            </div>
            {showLiveControls ? (
              <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                <Badge variant={ledgerStatus === "Connected" ? "success" : "warning"} className="rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em]">
                  Ledger: {ledgerStatus}
                </Badge>
                <div className="inline-flex rounded-full border border-border bg-background p-1">
                  <Button
                    size="sm"
                    variant={liveRefreshEnabled ? "default" : "ghost"}
                    onClick={() => setLiveRefreshEnabled(true)}
                    aria-label="Enable live refresh"
                    className="rounded-full px-4"
                  >
                    Live Refresh
                  </Button>
                  <Button
                    size="sm"
                    variant={!liveRefreshEnabled ? "default" : "ghost"}
                    onClick={() => setLiveRefreshEnabled(false)}
                    aria-label="Disable live refresh"
                    className="rounded-full px-4"
                  >
                    Refresh Off
                  </Button>
                </div>
                <Badge
                  variant={simulatorState?.status === "error" || simulator?.status === "failed" || simulator?.lastError ? "warning" : "outline"}
                  className="rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em]"
                  title={simulatorState?.error || undefined}
                >
                  Simulator: {simulatorState?.status === "error" ? "Unavailable" : `${simulator?.status || "Loading"} / ${simulator?.mode || "-"}${simulator?.mode === "story" && simulator?.storyKey ? ` / ${simulator.storyKey}` : ""}`}
                </Badge>
                {canControlSimulator && simulator ? (
                  <div className="inline-flex rounded-full border border-border bg-background p-1">
                    {["stopped", "paused", "failed"].includes(simulator.status) ? (
                      <>
                        <Button size="sm" variant={simulator.mode === "live" ? "default" : "ghost"} className="rounded-full px-3" disabled={simulatorState.controlPending} onClick={() => sendSimulatorCommand("mode", { mode: "live" })}>Sim Live</Button>
                        <Button size="sm" variant={simulator.mode === "static" ? "default" : "ghost"} className="rounded-full px-3" disabled={simulatorState.controlPending} onClick={() => sendSimulatorCommand("mode", { mode: "static" })}>Sim Static</Button>
                        {simulator.storyKey ? (
                          <Button size="sm" variant={simulator.mode === "story" ? "default" : "ghost"} className="rounded-full px-3" disabled={simulatorState.controlPending} onClick={() => sendSimulatorCommand("mode", { mode: "story", storyKey: simulator.storyKey })}>Sim Story</Button>
                        ) : null}
                      </>
                    ) : null}
                    {["stopped", "failed"].includes(simulator.status) && simulator.mode !== "off" ? (
                      <Button size="sm" variant="ghost" className="rounded-full px-3" disabled={simulatorState.controlPending} onClick={() => sendSimulatorCommand("start")}>Start</Button>
                    ) : null}
                    {simulator.status === "paused" ? (
                      <Button size="sm" variant="ghost" className="rounded-full px-3" disabled={simulatorState.controlPending} onClick={() => sendSimulatorCommand("resume")}>Resume</Button>
                    ) : null}
                    {["starting", "running"].includes(simulator.status) ? (
                      <Button size="sm" variant="ghost" className="rounded-full px-3" disabled={simulatorState.controlPending} onClick={() => sendSimulatorCommand("pause")}>Pause</Button>
                    ) : null}
                    {simulator.status !== "stopped" ? (
                      <Button size="sm" variant="ghost" className="rounded-full px-3" disabled={simulatorState.controlPending} onClick={() => sendSimulatorCommand("stop")}>Stop</Button>
                    ) : null}
                  </div>
                ) : null}
                <Button size="sm" variant="outline" onClick={refreshNow} className="rounded-full px-4">
                  Refresh
                </Button>
                <Badge variant="outline" className="rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em]">
                  Last: {lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "Waiting"}
                </Badge>
              </div>
            ) : null}
          </header>

          <Outlet />
        </main>
      </div>
    </div>
  );
}
