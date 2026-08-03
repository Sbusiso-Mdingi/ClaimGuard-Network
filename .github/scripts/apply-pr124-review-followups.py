from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_claims_repository() -> None:
    path = ROOT / "packages/database/src/claims-read-repository.js"
    text = path.read_text()
    text = replace_once(
        text,
        '''function displayText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}''',
        '''function displayText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}''',
        "displayText coercion",
    )
    path.write_text(text)


def patch_identity_test() -> None:
    path = ROOT / "packages/database/tests/claims-identity-presentation.test.js"
    text = path.read_text()
    text = replace_once(
        text,
        '''  provider_practice_number: "PR-1001",
  provider_specialty: "General Practitioner",''',
        '''  provider_practice_number: 1001,
  provider_specialty: Buffer.from("General Practitioner"),''',
        "non-string identity fixture",
    )
    text = replace_once(
        text,
        '''    practiceNumber: "PR-1001",
    specialty: "General Practitioner",''',
        '''    practiceNumber: "1001",
    specialty: "General Practitioner",''',
        "non-string identity assertions",
    )
    path.write_text(text)


def patch_desktop_workspace() -> None:
    path = ROOT / "apps/desktop/src/DesktopWorkspace.jsx"
    text = path.read_text()

    text = replace_once(
        text,
        '''    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const backgroundElements = Array.from(document.body.children)
      .filter((element) => element !== backdropRef.current)
      .map((element) => ({
        element,
        ariaHidden: element.getAttribute("aria-hidden"),
        hadInert: element.hasAttribute("inert"),
      }));
    document.body.style.overflow = "hidden";
    backgroundElements.forEach(({ element }) => {
      element.setAttribute("aria-hidden", "true");
      element.setAttribute("inert", "");
    });''',
        '''    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const appRoot = document.getElementById("app");
    const appRootState = appRoot ? {
      ariaHidden: appRoot.getAttribute("aria-hidden"),
      hadInert: appRoot.hasAttribute("inert"),
    } : null;
    document.body.style.overflow = "hidden";
    if (appRoot) {
      appRoot.setAttribute("aria-hidden", "true");
      appRoot.setAttribute("inert", "");
    }''',
        "scope overlay background lock",
    )

    text = replace_once(
        text,
        '''      document.body.style.overflow = previousOverflow;
      backgroundElements.forEach(({ element, ariaHidden, hadInert }) => {
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
        if (!hadInert) element.removeAttribute("inert");
      });''',
        '''      document.body.style.overflow = previousOverflow;
      if (appRoot && appRootState) {
        if (appRootState.ariaHidden === null) appRoot.removeAttribute("aria-hidden");
        else appRoot.setAttribute("aria-hidden", appRootState.ariaHidden);
        if (!appRootState.hadInert) appRoot.removeAttribute("inert");
      }''',
        "restore app root accessibility state",
    )

    text = replace_once(
        text,
        '''function ClaimsView({ claims, selectedClaim, loading, openClaim, closeClaim, openInvestigation, createInvestigation, canViewInvestigations, canCreateInvestigations, canAssignInvestigations, investigators, writesAllowed }) {''',
        '''function ClaimsView({ claims, openClaim }) {''',
        "simplify ClaimsView props",
    )

    text = replace_once(
        text,
        '''</CardContent></Card>
    <ClaimDetail payload={selectedClaim} loading={loading} onClose={closeClaim} onOpenInvestigation={openInvestigation} onCreateInvestigation={createInvestigation} canViewInvestigations={canViewInvestigations} canCreateInvestigations={canCreateInvestigations} canAssignInvestigations={canAssignInvestigations} investigators={investigators} writesAllowed={writesAllowed} />
  </div>;''',
        '''</CardContent></Card>
  </div>;''',
        "remove stale ClaimsView detail rendering",
    )

    text = replace_once(
        text,
        '''{activeView === "claims" ? <ClaimsView claims={claims} selectedClaim={null} loading={false} openClaim={openClaim} closeClaim={closeClaim} openInvestigation={openInvestigation} createInvestigation={createInvestigation} canViewInvestigations={canViewInvestigations} canCreateInvestigations={canCreateInvestigations} canAssignInvestigations={canAssignInvestigations} investigators={investigators} writesAllowed={writesAllowed} /> : null}''',
        '''{activeView === "claims" ? <ClaimsView claims={claims} openClaim={openClaim} /> : null}''',
        "simplify ClaimsView caller",
    )

    path.write_text(text)


def main() -> None:
    patch_claims_repository()
    patch_identity_test()
    patch_desktop_workspace()

    (ROOT / ".github/workflows/pr124-review-followups-once.yml").unlink()
    Path(__file__).unlink()


if __name__ == "__main__":
    main()
