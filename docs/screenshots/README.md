# Screenshots & GIFs

This folder holds the images referenced from the main [README](../../README.md).

## Recording

- **Static shots**: macOS Cmd+Shift+4 (region) or Cmd+Shift+5 (options).
- **GIFs**: [Kap](https://getkap.co) is the easiest — free, region-record → export GIF/MP4 in one step.
  Alternatives: [LICEcap](https://www.cockos.com/licecap/) (cross-platform, straight to GIF), or
  the macOS screen recorder (Cmd+Shift+5) piped through
  `ffmpeg -i in.mov -vf "fps=15,scale=800:-1" out.gif`.

## Conventions

- Keep GIFs ≤ 800 px wide and 10–15 fps — reads well on GitHub, keeps size under a few hundred KB.
- Show one feature per file. Trim aggressively.
- Filenames match the placeholders in the README (see below). Prefer `.png` for stills,
  `.gif` for interactions.

## Placeholders currently referenced by the README

| Filename                    | What it should show                                                     |
|-----------------------------|-------------------------------------------------------------------------|
| `hero.png`                  | Top-of-README hero shot: whole app with a populated layout.             |
| `sidebar-tabs.png`          | Sidebar with all four tabs visible; one tab open.                       |
| `editing-modes.gif`         | Cycling through Select → Box → Lasso → Move → Rotate on the toolbar.    |
| `add-element.gif`           | Pressing N at the cursor, filling the Add Element form, committing.     |
| `beam-path-edit.gif`        | Entering beam-path edit mode, clicking source → dest to add edges.      |
| `background-image.gif`      | Uploading a reference image, dragging, resizing via the corner handle.  |
| `transform-menu.gif`        | Opening Transform ▾, applying Rotate 90° right.                         |
| `projects-tab.png`          | The Projects panel (left side, expanded): Local Storage and Cloud Storage stacked, a cloud-linked project's sync icon, and the right-click menu. |
| `pdf-export.png`            | An exported PDF opened alongside the app for comparison.                |

Feel free to add more; just remember to reference them from the main README.

## Alternative: GitHub's issue-attachment CDN

For very large GIFs you'd rather not commit to the repo, open a new issue on the repo,
drag the file into the comment box, wait for GitHub to upload, copy the resulting
`user-images.githubusercontent.com/...` URL into the README, then close the issue
without submitting. The upload stays live indefinitely and doesn't bloat clones.
