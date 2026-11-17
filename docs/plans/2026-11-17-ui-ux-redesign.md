# TH-Plot UI/UX Redesign Implementation Plan


**Goal:** Turn the existing desktop-first engineering page into a coherent, accessible device workspace with a practical mobile workflow.

**Architecture:** Keep the existing BLE, chart, storage, image editing and upload engines. Rebuild the HTML information architecture and shared visual system. Add a small UI shell for navigation, state projection and progressive disclosure; load the optional 3D viewer only after an explicit request. All changes remain on `ui-redesign-20261117`; do not deploy.

**Tech Stack:** Semantic HTML, vanilla JavaScript, CSS, existing Fabric/localForage/chart dependencies, Playwright.

---

### Task 1: User journeys and regression baseline

- Record the starting HTML/behavior and establish UI tests outside the publishable app tree.
- Cover navigation and browser history, first-use connection guidance, offline history labeling, mobile editing modes, sticky upload availability, keyboard access and narrow viewports.
- Assert no eager Three/FBX/frame-sequence loading, no downloadable fonts and no automatic generic mobile warning.

### Task 2: Shared workspace and overview

- Rebuild desktop navigation as a sidebar and mobile navigation as a bottom bar.
- Keep the connection action consistently available, with one status area and clear disconnected guidance.
- Put live readings and useful destinations first; move product photos, 3D and technical resources to About.
- Implement a restrained light visual system with readable type, consistent spacing, visible focus and comfortable touch targets.

### Task 3: History and settings

- Make the history chart primary; group import/export and destructive import operations under explicit secondary disclosure.
- Organize settings by display, recording and calendar, preserving immediate apply behavior and warnings.
- Remove obsolete landing-page navigation and the unsolicited recommendation to use a computer.

### Task 4: Wallpaper workflow

- Organize slot choice, content preparation and final preview into numbered sections.
- Provide mobile mode buttons and an accessible file-selection surface; preserve live UTF-8 QR, system fonts, physical-pixel preview and image gestures.
- Keep output adjustments collapsed by default on mobile and the upload action reachable above the bottom navigation.
- Preserve all existing control IDs and the actual upload/cancel state; disabled actions must explain their dependency.

### Task 5: Optional 3D performance

- Extract the existing model into `device-model.js` and initialize it only when the user opens the preview in About.
- Pause animation/frame advancement when the viewer, page or document is hidden.

### Task 6: Verification and review

- Run the UI journey suite at375/390/768/1440 widths and review desktop/mobile screenshots.
- Verify image/text/QR editing,400/800 physical-pixel previews, one-time upload compression, draft persistence and mocked BLE transfer behavior.
- Parse all JavaScript/inline scripts, check the branch diff and request an independent review.
- Keep the original checkout and running preview intact; expose a separate local preview on port8767. Do not push or deploy.

## Local verification completed

- UI navigation and browser history, keyboard focus, mode selection and disabled-state guidance.
- All five pages at 320, 375, 390, 720, 721, 768, 1024, 1440 and 1920 CSS pixels, including live -40.0 °C / 100.0% readings.
- Physical 400×300 / 800×600 previews; mobile touch pan/pinch; independent mobile and desktop drafts; integer layer coordinates.
- Chinese/emoji QR decoding and pure black/white module edges; live text editing at 12/16/24/30 px across DPRs; system fonts without downloads.
- Mocked BLE image streaming, cancellation, disconnect, compression at upload, CRC commit, settings and connection error behavior.
- Optional 3D loads on demand and stops rendering when collapsed or its page is hidden.
- Independent review findings on text contrast and live-reading units fixed.
- JavaScript syntax, inline scripts, unique IDs and diff whitespace checked.

No deployment or remote push. Physical Bluetooth hardware still needs a final device acceptance check.

## Showcase follow-up

The homepage connection card now presents the real interactive 3D device directly. It loads automatically when Overview is entered, pauses when Overview or the document is hidden, and resumes when revisited. The retired static illustration and collapsed About viewer were removed.

Real device photos now immediately follow the About introduction. Mobile uses a vertical gallery with four captions and full-width images; desktop keeps a four-column grid. The example-data action has 12px vertical / 16px horizontal padding and a 44px minimum height.

Verified real model loading, homepage visibility, gallery order and mobile bounds, action padding, lifecycle pause/resume, UI journeys, all five pages at nine widths, JavaScript syntax and unique HTML IDs. No deployment.
