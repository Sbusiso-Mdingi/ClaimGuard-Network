import { CLAIMGUARD_ROLES } from "./claimguardRoles";

export const NAV_ITEMS = [
  { key: "dashboard", to: "/", label: "Dashboard", roles: [CLAIMGUARD_ROLES.SCHEME_USER, CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR] },
  { key: "claims", to: "/claims", label: "Claims Explorer", roles: [CLAIMGUARD_ROLES.SCHEME_USER, CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR] },
  { key: "network", to: "/network", label: "Network Graph", roles: [CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR] },
  { key: "risk", to: "/risk", label: "Risk Panel", roles: [CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR] },
  { key: "history", to: "/history", label: "Detection History", roles: [CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR] },
  { key: "investigations", to: "/investigations", label: "Investigations", roles: [CLAIMGUARD_ROLES.INVESTIGATOR, CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR] },
  { key: "committee", to: "/committee", label: "Shared Fraud Registry", roles: [CLAIMGUARD_ROLES.NEW_APPLICATIONS_OFFICER, CLAIMGUARD_ROLES.INVESTIGATOR, CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.SCHEME_USER, CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR] },
  { key: "scheme-admin", to: "/admin/scheme", label: "Scheme Administration", roles: [CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR] },
  { key: "platform-admin", to: "/admin/platform", label: "Platform Administration", roles: [CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR] },
];