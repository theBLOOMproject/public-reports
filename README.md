# Bloom's Public Reports Prototype

Interactive bloom report, published as a GitHub pages website via GitHub actions.

`main` branch is published on push, to `report.bloomproject.us`. Each report lives at
`/<slug>/`, where the slug is the name of its directory under `data/`; the site root
redirects to <https://bloom-project.org/>.

## Layout

| Path                           | Role                                                                   |
|--------------------------------|------------------------------------------------------------------------|
| `src/app.js`                   | The app code.                                                          |
| `src/app.css`                  | The styles.                                                            |
| `index.template.html`          | Markup only. The rest is inlined into it at build time.                |
| `data/<slug>/`                 | One report: JSON data, `report.json` copy/config, its own `static/`.   |
| `static/`                      | Fonts and SVG icons shared by every report.                            |
| `build.js`                     | Builds each report from the template, `src/` and its JSON into `dist/`.|
| `dist/`                        | Build output. Gitignored; regenerated on every deploy.                 |

The build produces one self-contained `index.html` per report — no external CSS or JS
requests — under `dist/<slug>/`, with a redirect stub at the `dist/` root:

```
dist/
├── index.html            redirect to bloom-project.org
├── 404.html              same stub, for unmatched paths
└── <slug>/               one per directory under data/
    ├── index.html        the report
    └── static/           the shared static/ plus the report's own
```

## Local preview

```sh
node build.js && (cd dist && python3 -m http.server 8000)
```
Then open http://localhost:8000/<slug>/ (e.g. `/central-oregon-ai/`) — not the root, which is the redirect
stub and will send you to bloom-project.org.

