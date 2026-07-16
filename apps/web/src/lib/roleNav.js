import { CLAIMGUARD_ROLES } from "./claimguardRoles";

export const NAV_GROUPS = [
  {
    key: "your-scheme",
    title: "YOUR SCHEME",
    subtitle: "Tenant workspace views scoped to your active medical scheme.",
    items: [
      {
        key: "dashboard",
        to: "/",
        label: "Dashboard",
        roles: [CLAIMGUARD_ROLES.SCHEME_USER, CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR],
      },
      {
        key: "claims",
        to: "/claims",
        label: "Claims",
        roles: [CLAIMGUARD_ROLES.SCHEME_USER, CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR],
      },
      {
        key: "investigations",
        to: "/investigations",
        label: "Investigations",
        roles: [CLAIMGUARD_ROLES.INVESTIGATOR, CLAIMGUARD_ROLES.FRAUD_ANALYST],
      },
      {
        key: "network",
        to: "/network",
        label: "Network",
        roles: [CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR],
      },
      {
        key: "risk",
        to: "/risk",
        label: "Risk",
        roles: [CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR],
      },
      {
        key: "history",
        to: "/history",
        label: "History",
        roles: [CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR],
      },
    ],
  },
  {
    key: "shared-ecosystem",
    title: "SHARED ECOSYSTEM",
    subtitle: "Confirmed fraud records shared between participating medical schemes.",
    items: [
      {
        key: "committee",
        to: "/committee",
        label: "Shared Fraud Registry",
        roles: [
          CLAIMGUARD_ROLES.NEW_APPLICATIONS_OFFICER,
          CLAIMGUARD_ROLES.INVESTIGATOR,
          CLAIMGUARD_ROLES.FRAUD_ANALYST,
          CLAIMGUARD_ROLES.SCHEME_USER,
        ],
      },
    ],
  },
  {
    key: "administration",
    title: "ADMINISTRATION",
    subtitle: "Tenant and platform governance controls.",
    items: [
      {
        key: "scheme-admin",
        to: "/admin/scheme",
        label: "Scheme Administration",
        roles: [CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR],
      },
      {
        key: "platform-admin",
        to: "/admin/platform",
        label: "Platform Administration",
        roles: [CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR],
      },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);
