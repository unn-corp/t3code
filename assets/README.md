# Arcwright Code brand assets

The transparent GPT Image masters are `arcwright/mark.png` (the square AC and lightning logo)
and `arcwright/wordmark.png` (the name on one line). They are the source of truth for every client
and release channel. The exported theme variants trim transparent padding; dark surfaces use
white lettering while preserving the blue bolt.

Use `arcwright/wordmark-on-dark.png` for the transparent white wordmark and
`arcwright/mark-square-on-dark.png` for its square transparent companion. Black-lettered
versions are available for light surfaces.

Run `vp run icons:export` after changing a master. This regenerates desktop PNG and ICO files,
macOS installer wordmarks, iOS images and Icon Composer projects, web favicons and PWA images, Android adaptive/splash/
notification artwork, and the mobile widget mark. Run `vp run icons:check` to verify all tracked
outputs without writing them. Exporting runs on Linux, Windows, and macOS using the repository's
Sharp and PNG dependencies; Icon Composer is not required.

The platform paths remain in [brand-assets.ts](../scripts/lib/brand-assets.ts). Existing
development/nightly/production filenames are retained, but every variant uses the same AC mark.
App, package, protocol, and data-directory identities remain compatible with installed forks.

macOS icons have an 824px rounded body inset 100px in a transparent 1024px canvas. iOS images
are opaque full squares. Android foregrounds keep the entire mark within the launcher's safe
zone; the full-bleed background and composed splash use the same dark surface. Notification,
themed launcher, and widget marks are monochrome silhouettes with transparent backgrounds.

Edit the masters and regenerate; do not edit generated platform files individually.
