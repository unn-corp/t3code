---
version: alpha
name: T3 Code
description: A compact, native-feeling workspace for directing coding agents.
colors:
  primary: "oklch(0.488 0.217 264)"
  primary-dark: "oklch(0.588 0.217 264)"
  background: "oklch(0.992 0 0)"
  background-dark: "#0A0A0A"
  surface: "#FFFFFF"
  surface-dark: "#0F0F0F"
  on-surface: "#27272A"
  on-surface-dark: "#F5F5F5"
  muted: "#FAFAFA"
  muted-dark: "#18181B"
  muted-foreground: "#71717A"
  muted-foreground-dark: "#A1A1AA"
  border: "#E4E4E7"
  border-dark: "rgb(255 255 255 / 8%)"
  error: "#EF4444"
  info: "#3B82F6"
  success: "#10B981"
  warning: "#F59E0B"
typography:
  headline-lg:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.3px
  headline-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: 0
  body-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  label-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.333
    letterSpacing: 0
  code-md:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    borderColor: "{colors.border}"
    rounded: "{rounded.xl}"
    padding: 16px
  filter-control:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    minHeight: 36px
  status-badge:
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: "2px 4px"
---

## Overview

T3 Code should feel like a well-made native IDE inspector: dense, quiet, immediate, and built for people who keep it open all day. GitHub issue lists and native macOS inspectors are the closest references. Information hierarchy comes from typography, restrained tonal surfaces, and small semantic accents, not decorative art.

## Colors

Neutral zinc surfaces carry the workspace in both themes. Indigo is reserved for the primary action and keyboard focus. Red, amber, blue, and emerald communicate error, warning, active information, and success. Color must always be paired with text or an icon.

## Typography

Use the operating system sans-serif stack for interface text so the app feels native on every platform. Use the monospace stack only for code, branches, paths, identifiers, and command output. Dashboard headings stay compact and sentence case.

## Layout

Use a fluid, mobile-first column with a maximum readable width. The spacing rhythm is 4, 8, 12, 16, 24, and 32 pixels. Dense lists should group related records without hiding primary actions. At 42rem and above, controls may move into horizontal rows and cards may gain additional columns.

## Elevation & Depth

Prefer one-pixel borders and subtle tonal lifts over large shadows. Cards use a near-flat shadow only to separate adjacent interactive surfaces. Dark mode lifts cards slightly from the black workspace without producing milky gray panels.

## Shapes

Controls use 6 to 10 pixel corners. Cards use 14 pixel corners. Pills are reserved for statuses, counts, and compact filters. Do not mix decorative shape languages within one surface.

## Components

Buttons preserve a 44 pixel coarse-pointer hit area even when the visual control is compact. Cards lead with the finding title, then status and provenance, then actions. Filters always have accessible names and visible selected states. Finding types use Lucide icons from the existing application icon set.

## Do's and Don'ts

- Do optimize for scanning many projects and findings without losing context.
- Do keep filters reversible, keyboard accessible, and useful on narrow screens.
- Do use existing application tokens and primitives before adding CSS.
- Do keep all visible copy concise and in sentence case.
- Don't use eyebrow text, gradients, oversized marketing typography, or decorative dashboards.
- Don't use color as the only signal or hide unavailable collector state.
- Don't introduce continuous animations or hover transforms that cause layout movement.
