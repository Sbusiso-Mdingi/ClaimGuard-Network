import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Building2 from "lucide-react/dist/esm/icons/building-2.mjs";
import FileClock from "lucide-react/dist/esm/icons/file-clock.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import LayoutDashboard from "lucide-react/dist/esm/icons/layout-dashboard.mjs";
import Menu from "lucide-react/dist/esm/icons/menu.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Network from "lucide-react/dist/esm/icons/network.mjs";
import SearchCheck from "lucide-react/dist/esm/icons/search-check.mjs";
import Settings from "lucide-react/dist/esm/icons/settings.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Button } from "../../components/ui/button";
import { useRole } from "../../context/RoleContext";
import { canAccessNavItem, NAV_GROUPS } from "../../lib/roleNav";
import {
  defaultRouteForIdentity,
  formatIdentityRoles,
} from "../../lib/capabilities";

function isLiveDetectionRoute(pathname) {
  return (
    pathname === "/" ||
    pathname === "/dashboard" ||
    pathname.startsWith("/claims") ||
    pathname === "/network" ||
    pathname === "/risk" ||
    pathname === "/history"
  );
}

const NAV_ICONS = Object.freeze({
  dashboard: LayoutDashboard,
  claims: FileText,
  investigations: SearchCheck,
  network: Network,
  risk: ShieldAlert,
  history: FileClock,
  committee: SearchCheck,
  "scheme-admin": Building2,
  "platform-admin": Settings,
});

export function InvestigatorLayout({
  ledgerStatus,
}) {
  const { identity, logout, mode } = useRole();
  const location = useLocation();
  const visibleNavGroups = useMemo(
    () =>
      NAV_GROUPS
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => canAccessNavItem(identity, item)),
        }))
        .filter((group) => group.items.length > 0),
    [identity],
  );
  const showLiveControls = isLiveDetectionRoute(location.pathname);
  const isPlatformWorkspace = identity.organisationType === "platform";
  const workspaceLabel = isPlatformWorkspace ? "Platform operations" : "Scheme workspace";
  const contextLabel = isPlatformWorkspace ? "Organisation:" : "Scheme:";

  const [theme, setTheme] = useState(() => window.localStorage.getItem("claimguard-theme") || "dark");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia?.("(min-width: 1024px)").matches ?? true,
  );
  const closeNavigationButtonRef = useRef(null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    window.localStorage.setItem("claimguard-theme", theme);
  }, [theme]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const media = window.matchMedia?.("(min-width: 1024px)");
    if (!media) return undefined;
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isDesktop && sidebarOpen) {
      closeNavigationButtonRef.current?.focus();
    }
  }, [isDesktop, sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-[60] -translate-y-20 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg transition-transform focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>
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
          <p className="font-data text-xs uppercase tracking-[0.2em] text-muted">ClaimGuard workspace</p>
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

      <div className="mx-auto grid min-h-screen w-full max-w-[1720px] grid-cols-1 lg:grid-cols-[248px_1fr]">
        <aside
          aria-label="Workspace navigation"
          aria-hidden={!isDesktop && !sidebarOpen}
          aria-modal={!isDesktop && sidebarOpen ? "true" : undefined}
          role={!isDesktop && sidebarOpen ? "dialog" : undefined}
          inert={!isDesktop && !sidebarOpen ? "" : undefined}
          className={[
            "fixed inset-y-0 left-0 z-40 flex h-screen w-[248px] flex-col overflow-y-auto border-r border-border-soft bg-surface-elevated px-4 py-5 transition-transform duration-200 investigator-scrollbar",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
            "lg:sticky lg:top-0 lg:z-auto lg:w-auto lg:translate-x-0",
          ].join(" ")}
        >
          <div className="mb-6 flex items-center justify-between gap-3">
            <Link to={defaultRouteForIdentity(identity)} className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary border border-border-soft shadow-inner">
                <Activity className="h-5 w-5" />
              </span>
              <div>
                <p className="font-display text-[15px] font-semibold tracking-tight leading-none text-foreground">ClaimGuard</p>
                <p className="font-data text-[9px] uppercase tracking-[0.2em] text-muted-2 mt-1">{workspaceLabel}</p>
              </div>
            </Link>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 rounded-full hidden lg:inline-flex text-muted-2 hover:text-foreground hover:bg-secondary/70"
                onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 rounded-full lg:hidden text-muted-2 hover:bg-secondary/70 hover:text-foreground"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close navigation"
                ref={closeNavigationButtonRef}
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
                  {group.items.map((item) => {
                    const Icon = NAV_ICONS[item.key] || Activity;
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.to === "/dashboard"}
                        className={({ isActive }) =>
                          [
                            "group flex items-center gap-3 rounded-[10px] px-2 py-2 text-[13px] font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary",
                            isActive
                              ? "bg-primary/10 text-primary shadow-[inset_2px_0_0_0_currentColor]"
                              : "text-muted hover:bg-secondary/60 hover:text-foreground",
                          ].join(" ")
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <span className={`flex h-7 w-7 items-center justify-center rounded-lg border ${isActive ? "border-primary/25 bg-primary/15 text-primary" : "border-border-soft bg-black/20 text-muted"}`}>
                              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                            </span>
                            <span className="flex-1">{item.label}</span>
                          </>
                        )}
                      </NavLink>
                    );
                  })}
                </div>
              </section>
            ))}
          </nav>

          <div className="mt-auto space-y-4 pt-6 border-t border-border-soft/50">
            {mode === "session" ? (
              <div className="rounded-[12px] border border-border-soft bg-surface-card p-3 shadow-sm">
                <p className="text-[13px] font-semibold text-foreground">{identity.label}</p>
                <p className="text-[11px] text-muted-2 mt-0.5">{identity.tenantLabel}</p>
                <Button type="button" variant="outline" size="sm" className="mt-3 h-8 w-full border-border-soft bg-background/50 text-xs text-muted hover:bg-secondary/70 hover:text-foreground" onClick={logout}>Sign out</Button>
              </div>
            ) : null}
          </div>
        </aside>

        <main id="main-content" tabIndex={-1} className="min-w-0 p-4 outline-none md:p-6 xl:p-8">
          <header className="mb-6 flex flex-col gap-4 rounded-xl border border-border-soft bg-surface-elevated px-4 py-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border-soft bg-background/55 px-3 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-[#71a8d9]" aria-hidden="true" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{contextLabel}</span>
                <span className="text-[11px] font-semibold text-foreground">{identity.tenantLabel || identity.tenantId}</span>
              </div>
              <div className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border-soft bg-background/55 px-3 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Role:</span>
                <span className="text-[11px] font-semibold text-foreground">{formatIdentityRoles(identity)}</span>
              </div>
              {mode === "session" ? (
                <div className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border-soft bg-background/55 px-3 py-1">
                  <Activity className="h-3 w-3 text-[#62ce9b]" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
                    Authenticated
                  </span>
                </div>
              ) : null}
            </div>
            {showLiveControls ? (
              <div className="flex flex-wrap items-center gap-2.5 lg:justify-end">
                <div className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border-soft bg-background/55 px-3 py-1 ${ledgerStatus === "Connected" ? "text-emerald-600 dark:text-[#62ce9b]" : "text-amber-700 dark:text-[#e6a74d]"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${ledgerStatus === "Connected" ? "bg-[#62ce9b]" : "bg-[#e6a74d]"}`} aria-hidden="true" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Ledger:</span>
                  <span className="text-[11px] font-semibold">{ledgerStatus}</span>
                </div>
              </div>
            ) : null}
          </header>

          <Outlet />
        </main>
      </div>
    </div>
  );
}
