---
name: OpenClaw Project Northstar
description: A calm, owner-first native workspace with authoritative chat and restrained Glass OS hierarchy.
colors:
  scene-foundation: "#020506"
  scene-raised: "#071012"
  scene-elevated: "#0b1618"
  content-primary: "#fff3df"
  content-strong: "#fffaf0"
  accent-aqua: "#8debe2"
  semantic-warning: "#ffdaa2"
  semantic-info: "#c8b6ff"
  semantic-danger: "#ffaaa4"
typography:
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.25
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
  data:
    fontFamily: "JetBrains Mono, SFMono-Regular, SF Mono, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  control: "8px"
  panel: "14px"
  focal: "20px"
components:
  navigation-item:
    backgroundColor: "{colors.scene-raised}"
    textColor: "{colors.content-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  chat-surface:
    backgroundColor: "{colors.scene-foundation}"
    textColor: "{colors.content-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
  inspector-surface:
    backgroundColor: "{colors.scene-raised}"
    textColor: "{colors.content-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.panel}"
    padding: "16px"
---

## Overview

**Creative North Star: "The Quiet Operations Desk."** Project Northstar is the owner's private working surface, not a public SaaS dashboard. The composition is native and task-first: a stable navigation hierarchy at left, authoritative Main chat in the center, and an optional contextual inspector at right. Glass OS appears as a small number of structural planes over a dark luminous scene. Content stays sharp, stable, and dominant.

The token values above are the bounded Project Northstar palette and geometry carried from current OpenClaw and active Glass OS evidence into a source-owned contract. Implementation must place them in existing source styles behind explicit theme, shell, and component selectors. The deployed runtime `custom.css` remains migration evidence only and is not the maintained source of truth.

**The Authority Rule.** The center chat is never visually demoted beneath project chrome, metrics, agent activity, or the inspector.

**The Rare Glass Rule.** Glass marks shell hierarchy, a true inspector, or a focused overlay. Repeated rows, navigation items, messages, badges, and ordinary controls inherit their parent plane and do not become independent glass cards.

**The Stable Compact Rule.** At 200% text, compact widths, and long labels, the layout reflows or discloses progressively. It never clips a pill, truncates the only meaningful action, or creates horizontal page scroll.

## Colors

The default scene is a near-black graphite and teal foundation with warm ivory foreground. Aqua identifies current selection, primary action, and clear informational emphasis. Warm gold communicates warning or attention, violet is reserved for bounded informational context, and rose communicates destructive or failed state. Semantic state always includes text, iconography, or another non-color cue.

**The Quiet Center Rule.** Ordinary surfaces remain neutral. Saturated color belongs to current selection, primary action, status, focus, or localized scene transmission, never inactive decoration.

**The Solid Fallback Rule.** Reduced transparency and unsupported optical effects use the same hierarchy with opaque source-owned surface colors. Forced colors removes decorative optics and preserves native semantic borders, focus, selection, and status.

## Typography

G014 retains the current OpenClaw product typography so the shell feels native and the change stays bounded. The source stack uses Inter with platform sans fallbacks for interface text and JetBrains Mono with platform monospace fallbacks for runtime facts. A font migration is not part of this shell story.

Use weight, spacing, and placement for hierarchy. UI labels remain compact and direct. Chat prose should stay within a readable measure of roughly 65 to 75 characters where the layout permits. Session names and project labels may truncate only when the full value remains accessible through a standard disclosure or tooltip, never through clipped geometry.

**The Product Voice Rule.** Labels state the object or action directly. Do not add marketing copy, decorative uppercase captions, or display styling to operational controls.

## Elevation

Elevation is structural, not ornamental. The foundation owns the application scene. The left navigation and optional inspector are quiet adjacent planes separated by a thin semantic boundary. The chat content plane remains visually open. A focused drawer, sheet, menu, or approval surface may rise one level with a measured shadow and stronger edge.

Blur is optional and bounded. Do not apply backdrop filtering to repeated messages, session rows, badges, or every card-like region. No full-viewport blur layer sits behind scrolling content. Reduced transparency swaps optical treatment for opaque surfaces without changing layout, controls, or reading order.

**The One Scene Rule.** Every elevated surface belongs to the same scene. Components do not create private ambient gradients, glows, render loops, or unrelated lighting.

## Components

### Native Workspace Shell

- **Left navigation:** project, pinned conversation, and session hierarchy using the existing native navigation owner. Rows are rectangular with restrained corners, stable text baselines, and explicit selected, active, waiting, and unread states. They are not clipped capsules.
- **Center chat:** the authoritative Main conversation uses the existing chat route, transcript, composer, approvals, and session behavior. G014 changes shell composition and source-owned visual treatment, not chat authority.
- **Right inspector:** optional contextual shell for plan, agents, changes, validation, context, routing, memory, or events as those projections become available. On wide layouts it may sit beside chat. On narrower layouts it becomes a labelled drawer or sheet and returns focus to its exact invoker.
- **Work status:** reserve a stable shell seam for the later sticky work HUD. G014 must not invent activity state or infer progress from prose.

### Navigation and Controls

Interactive targets provide default, hover, focus-visible, active, selected, disabled, loading, and error treatment when applicable. Keyboard order follows the visual hierarchy. Visible focus is never replaced by glow alone. Compact and high-text layouts keep primary controls reachable and use at least a 44 CSS pixel touch target where controls become touch-facing.

### Responsive Composition

Wide screens use left navigation, center chat, and an optional right inspector without forcing a fixed universal ratio. Medium screens keep the chat primary and collapse the inspector before compressing transcript readability. Narrow screens use the existing navigation drawer pattern; the inspector becomes a separate drawer or sheet, never a second permanently visible rail. Only one temporary overlay owns focus at a time. At 200% text, persistent regions may stack, scroll internally, or collapse through explicit controls, but their labels and primary actions remain available.

### Motion and Accessibility

Motion communicates opening, closing, selection, and state change within the existing fast product timings. Reduced motion removes spatial transitions and ambient drift while keeping immediate state feedback. Forced colors uses system colors and real outlines. Reduced transparency selects solid planes. All shell regions use landmarks and accessible names, and toggles expose expanded state and controlled-region relationships.

### Runtime Theme Replacement

Move the approved tokens and necessary component rules into the existing `ui/src/styles/` ownership structure. Bind them to explicit source classes, elements, or data attributes already owned by the component. Validate each migrated rule against the component it targets. After the source build reproduces the approved shell and screenshot defects are absent, replace the release-level stylesheet through the existing versioned candidate, canary, activation, and rollback process. Do not edit the active runtime file in place.

## Do's and Don'ts

### Do:

- **Do** keep the left navigation, center Main chat, and optional right inspector inside the existing native OpenClaw shell.
- **Do** keep chat visually and semantically authoritative while supporting project and session context points back to it.
- **Do** use the source-owned color, typography, radius, focus, and motion tokens through explicit selectors in `ui/src/styles/`.
- **Do** use thin boundaries, tonal separation, and restrained depth before adding another container.
- **Do** verify keyboard navigation, focus return, reduced motion, reduced transparency, forced colors, compact widths, long labels, and 200% text before acceptance.
- **Do** preserve a solid, readable fallback with identical content and actions.

### Don't:

- **Don't** build a generic public SaaS dashboard, a detached project control center, or a plugin-only primary workspace.
- **Don't** use broad runtime selectors such as `[class*="nav-"]`, `[class*="sidebar"]`, `[class*="chat-message"]`, or `[class*="composer"]`. They create cross-component regressions and caused the observed clipped border and pill artifacts.
- **Don't** use decorative glassmorphism, blur every surface, or turn messages, rows, controls, and badges into separate glass cards.
- **Don't** create nested cards, repeated card grids, excessive pills, universal capsules, or rounded containers that clip text, focus rings, borders, or scroll content.
- **Don't** use gradient text, `background-clip: text`, frosted text, noisy neon, decorative glow, or ambient motion that competes with reading.
- **Don't** communicate status through aqua, gold, violet, rose, blur, glow, or depth alone.
- **Don't** change the live `custom.css` directly. Replace it only after a source-owned candidate is built, tested, canaried, activated through the supported Control UI root, and covered by rollback evidence.
