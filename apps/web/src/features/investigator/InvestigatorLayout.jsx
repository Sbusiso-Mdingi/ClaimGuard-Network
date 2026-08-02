import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Building2 from "lucide-react/dist/esm/icons/building-2.mjs";
import ChevronsLeft from "lucide-react/dist/esm/icons/chevrons-left.mjs";
import ChevronsRight from "lucide-react/dist/esm/icons/chevrons-right.mjs";
import FileClock from "lucide-react/dist/esm/icons/file-clock.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import LayoutDashboard from "lucide-react/dist/esm/icons/layout-dashboard.mjs";
import LogOut from "lucide-react/dist/esm/icons/log-out.mjs";
import Menu from "lucide-react/dist/esm/icons/menu.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Network from "lucide-react/dist/esm/icons/network.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import SearchCheck from "lucide-react/dist/esm/icons/search-check.mjs";
import Settings from "lucide-react/dist/esm/icons/settings.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Button } from "../../components/ui/button";
import { useRole } from "../../context/RoleContext";
import { AccountMenu } from "../auth/AccountMenu";
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
  "platform-overview": LayoutDashboard,
  "platform-schemes": Building2,
  "platform-integrations": Network,
  "platform-releases": FileClock,
  "platform-administrators": ShieldCheck,
  "platform-detection": Settings,
});

export function InvestigatorLayout({ ledgerStatus }) {
  const { identity, logout, mode } = useRole();
  const effectiveIdentity = identity || {
    id: null,
    userId: null,
    label: "Authenticated account",
    role: null,
    roles: [],
    capabilities: [],
    tenantId: null,
    tenantSlug: null,
    tenantLabel: "Unknown",
    organisationId: null,
    organisationSlug: null,
    organisationType: "medical_scheme",
  };
  const location = useLocation();
  const visibleNavGroups = useMemo(
    () =>
      NAV_GROUPS
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => canAccessNavItem(effectiveIdentity, item)),
        }))
        .filter((group) => group.items.length > 0),
    [effectiveIdentity],
  );
  const showLiveControls = isLiveDetectionRoute(location.pathname);
  const canSearchClaims = visibleNavGroups.some((group) =>
    group.items.some((item) => item.key === "claims"),
  );
  const isPlatformWorkspace = effectiveIdentity.organisationType === "platform";
  const workspaceLabel = isPlatformWorkspace ? "Platform operations" : "Scheme workspace";
  const contextLabel = isPlatformWorkspace ? "Organisation:" : "Scheme:";
  const contextValue = effectiveIdentity.tenantLabel || effectiveIdentity.tenantId || "Unknown";
  const roleLabel = formatIdentityRoles(effectiveIdentity);

  const [theme, setTheme] = useState(
    () => window.localStorage.getItem("claimguard-theme") || "light",
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("claimguard-sidebar-collapsed") === "true",
  );
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
    window.localStorage.setItem(
      "claimguard-sidebar-collapsed",
      sidebarCollapsed ? "true" : "false",
    );
  }, [sidebarCollapsed]);

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
    if (!isDesktop && sidebarOpen) closeNavigationButtonRef.current?.focus();
  }, [isDesktop, sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen]);

  const toggleTheme = () => setTheme((previous) => (previous === "dark" ? "light" : "dark"));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-[70] -translate-y-20 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>

      <div className="sticky top-0 z-30 flex min-h-14 items-center justify-between gap-3 border-b border-border bg-card px-3 lg:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-11 w-11 shrink-0 rounded-md"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-none">ClaimGuard</p>
            <p className="mt-1 truncate text-[10px] text-muted-foreground">{workspaceLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-11 w-11 rounded-md"
            onClick={toggleTheme}
            aria-label="Toggle theme on mobile"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <AccountMenu identity={effectiveIdentity} roleLabel={roleLabel} onLogout={logout} compact />
        </div>
      </div>

      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-40 bg-slate-950/65 lg:hidden"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <div className="flex min-h-screen w-full">
        <aside
          aria-label="Workspace navigation"
          aria-hidden={!isDesktop && !sidebarOpen}
          aria-modal={!isDesktop && sidebarOpen ? "true" : undefined}
          role={!isDesktop && sidebarOpen ? "dialog" : undefined}
          inert={!isDesktop && !sidebarOpen ? "" : undefined}
          className={[
            "fixed inset-y-0 left-0 z-50 flex h-screen w-[272px] flex-col overflow-hidden border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar))] text-[hsl(var(--sidebar-foreground))] transition-[width,transform] duration-200",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
            sidebarCollapsed ? "lg:w-[72px]" : "lg:w-[256px]",
            "lg:sticky lg:top-0 lg:z-auto lg:translate-x-0",
          ].join(" ")}
        >
          <div className="flex min-h-14 items-center border-b border-[hsl(var(--sidebar-border))] px-3">
            <Link
              to={defaultRouteForIdentity(effectiveIdentity)}
              className={`flex min-w-0 flex-1 items-center gap-2.5 ${sidebarCollapsed ? "lg:justify-center" : ""}`}
              title={sidebarCollapsed ? "ClaimGuard" : undefined}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[hsl(var(--sidebar-primary))] text-[hsl(var(--sidebar-primary-foreground))]">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className={`min-w-0 ${sidebarCollapsed ? "lg:hidden" : ""}`}>
                <span className="block truncate text-sm font-semibold tracking-tight">ClaimGuard</span>
                <span className="mt-0.5 block truncate text-[10px] text-[hsl(var(--sidebar-foreground)/0.58)]">
                  {isPlatformWorkspace ? workspaceLabel : "Network · Fraud Detection"}
                </span>
              </span>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 shrink-0 text-[hsl(var(--sidebar-foreground)/0.7)] hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-foreground))] lg:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
              ref={closeNavigationButtonRef}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <nav className="investigator-scrollbar flex-1 overflow-y-auto px-2 py-4">
            <div className="space-y-5">
              {visibleNavGroups.map((group, groupIndex) => (
                <section key={group.key} aria-label={group.title}>
                  {sidebarCollapsed ? (
                    groupIndex > 0 ? <div className="mx-2 mb-3 h-px bg-[hsl(var(--sidebar-border))]" /> : null
                  ) : (
                    <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--sidebar-foreground)/0.48)]">
                      {group.title}
                    </p>
                  )}
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const Icon = NAV_ICONS[item.key] || Activity;
                      return (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          end={Boolean(item.end || item.to === "/dashboard")}
                          title={sidebarCollapsed ? item.label : undefined}
                          className={({ isActive }) =>
                            [
                              "group relative flex min-h-10 items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors",
                              sidebarCollapsed ? "lg:justify-center lg:px-0" : "",
                              isActive
                                ? "bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-foreground))] before:absolute before:-left-2 before:inset-y-1.5 before:w-0.5 before:rounded-r before:bg-[hsl(var(--sidebar-primary))]"
                                : "text-[hsl(var(--sidebar-foreground)/0.72)] hover:bg-[hsl(var(--sidebar-accent)/0.7)] hover:text-[hsl(var(--sidebar-foreground))]",
                            ].join(" ")
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <Icon
                                className={`h-4 w-4 shrink-0 ${isActive ? "text-[hsl(var(--sidebar-primary))]" : ""}`}
                                aria-hidden="true"
                              />
                              <span className={`min-w-0 flex-1 truncate ${sidebarCollapsed ? "lg:hidden" : ""}`}>
                                {item.label}
                              </span>
                            </>
                          )}
                        </NavLink>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </nav>

          {mode === "session" && identity ? (
            <div className="border-t border-[hsl(var(--sidebar-border))] p-2.5">
              {sidebarCollapsed ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="hidden h-11 w-full text-[hsl(var(--sidebar-foreground)/0.75)] hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-foreground))] lg:inline-flex"
                  onClick={logout}
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-10 w-full justify-start text-xs text-[hsl(var(--sidebar-foreground)/0.7)] hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-foreground))]"
                  onClick={logout}
                >
                  <LogOut className="mr-2 h-3.5 w-3.5" /> Sign out
                </Button>
              )}
            </div>
          ) : null}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 hidden min-h-16 items-center gap-3 border-b border-border bg-card px-5 lg:flex">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 shrink-0"
              onClick={() => setSidebarCollapsed((previous) => !previous)}
              aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
            >
              {sidebarCollapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
            </Button>

            {canSearchClaims ? (
              <Button asChild variant="outline" size="sm" className="h-10 w-full max-w-[520px] justify-start rounded-lg bg-background/60 text-muted-foreground shadow-sm">
                <Link to="/claims">
                  <Search className="mr-2.5 h-4 w-4" /> Search claims, providers, cases…
                </Link>
              </Button>
            ) : null}

            <div className="ml-auto flex min-w-0 items-center gap-2">
              <div className="hidden h-10 min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 shadow-sm xl:flex">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{contextLabel}</span>
                <span className="max-w-[210px] truncate text-sm font-medium">{contextValue}</span>
              </div>
              <div className="hidden items-center gap-1.5 rounded-md border border-border bg-secondary/45 px-2.5 py-1.5 2xl:flex">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Role:</span>
                <span className="text-xs font-semibold">{roleLabel}</span>
              </div>
              {showLiveControls ? (
                <div className={`hidden items-center gap-1.5 rounded-md border px-2.5 py-1.5 xl:flex ${ledgerStatus === "Connected" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${ledgerStatus === "Connected" ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden="true" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">Ledger {ledgerStatus}</span>
                </div>
              ) : null}
              <Button variant="ghost" size="sm" className="h-9 w-9" onClick={toggleTheme} aria-label="Toggle theme">
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
              <AccountMenu identity={effectiveIdentity} roleLabel={roleLabel} onLogout={logout} />
            </div>
          </header>

          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 bg-background p-4 outline-none sm:p-6 xl:p-8">
            <div className="mb-4 flex flex-wrap items-center gap-2 lg:hidden">
              <div className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{contextLabel}</span>
                <span className="text-xs font-semibold">{contextValue}</span>
              </div>
              {showLiveControls ? (
                <div className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 py-1.5 ${ledgerStatus === "Connected" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${ledgerStatus === "Connected" ? "bg-emerald-500" : "bg-amber-500"}`} />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">Ledger {ledgerStatus}</span>
                </div>
              ) : null}
            </div>
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
