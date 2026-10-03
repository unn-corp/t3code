# Settings and project overrides

The Settings breadcrumb ends with the environment and project a change applies to. They start
at **All environments** and **All projects** and stay selected as you move between categories or
search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Project category, shown while a project is selected, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

For workspace mode, a project's `t3.json` preference applies when the project has no override.
Browser access changes apply when an agent session next starts.

## Project icons

Select the project and open Project to choose an icon, emoji, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

# Add product context

Open **Settings**, select **Projects**, choose a project, then find **Product context**. The default document is `PRODUCT.md`, but you can choose another repository-relative Markdown path.

Select **Start conversation** to open a project-linked agent thread. The agent inspects the repository before asking focused questions, maintains a living product-document draft, and distinguishes human-confirmed information from repository inferences and unknowns. It asks for approval before writing or replacing the document.

After reviewing the saved document, turn on **Confirmed for automation**. Scheduled product opportunity discovery will not use an unconfirmed document. Changing the document path clears confirmation so the new source must be reviewed explicitly.

# Control project automations

The **Automations** section lets you independently allow or pause repository reviews, continuous improvement, product opportunity discovery, decision follow-up, pull request rollups, and inactive worktree cleanup. These controls apply to every checkout grouped under the project. Global automation settings still determine whether an allowed automation is running and how it is scheduled.

## Automatically pull

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

## Shared projects

Connect your Teams account in **Settings > Connections > Teams** on the environment
that will hold your checkout. Choose **Sign in to Teams** and approve sign-in in your
browser. If your environment has no team service configured, enter your team owner's
service URL under **Advanced** first. Use **Open shared project** or **Create shared project**
in the command palette, or **Share this project** from the project menu or Project
settings. Choose a new local directory when opening or creating a shared project.
Sharing an existing project keeps its project entry and uploads the checked Git
history. Existing conversations remain private until you explicitly share them.

After signing in, **Open shared project** lists the projects you can access. Team
owners see every project in this team; other members see only their assigned
projects. Every team member can create a shared project and choose existing
teammates as contributors or viewers, either during creation or in Project settings.
The project creator and team owners can add or remove existing teammates. The
creator's project access is protected while they remain a team member.

Only team owners invite new people to the team, change team roles, or remove team
members. Use **Settings > Connections > Teams** to manage the team. Give the
single-use team invitation code to the invited person; they accept it there or in
**Open shared project** using their verified sign-in email. Codes expire after
seven days and no invitation email is sent automatically. Joining a team does not
grant access to every project; a creator or team owner assigns projects afterward.
Use **Refresh team access** after access changes. Team owners always retain access
to all team projects, even without an explicit project assignment.

Project settings show your project role, connection, file synchronization, and
conflicts. Contributors collaborate and run local agents. Viewers read shared
conversations and files. Project ownership does not grant team administration.

Enable live files to exchange tracked file changes. Include new untracked files
explicitly. Resolve conflicts using the displayed local or shared version; preserved
local children must be moved before resolving a directory conflict. Fetching or
publishing Git history does not automatically commit, reset, or merge your checkout.
Pause live files or unlink the project to stop synchronization. Unlinking keeps your
local checkout, conversations, and already shared history.

Agents and provider credentials stay on your own machine. Shared access controls
limit collaboration and new agent starts through T3; they do not sandbox an agent's
access to your local operating system. Shared file operations currently require a
Linux T3 environment. Web and desktop support the native Teams interface; the mobile
app keeps its ordinary local chat interface.
