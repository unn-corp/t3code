# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

# Add product context

Open **Settings**, select **Projects**, choose a project, then find **Product context**. The default document is `PRODUCT.md`, but you can choose another repository-relative Markdown path.

Select **Start conversation** to open a project-linked agent thread. The agent inspects the repository before asking focused questions, maintains a living product-document draft, and distinguishes human-confirmed information from repository inferences and unknowns. It asks for approval before writing or replacing the document.

After reviewing the saved document, turn on **Confirmed for automation**. Scheduled product opportunity discovery will not use an unconfirmed document. Changing the document path clears confirmation so the new source must be reviewed explicitly.

# Control project automations

The **Automations** section lets you independently allow or pause repository reviews, continuous improvement, product opportunity discovery, decision follow-up, pull request rollups, and inactive worktree cleanup. These controls apply to every checkout grouped under the project. Global automation settings still determine whether an allowed automation is running and how it is scheduled.
