# Bloom's Public Reports Prototype

Interactive bloom report, published as a GitHub pages website via GitHub actions.

`main` branch is published on push, to `report.bloomproject.us`. The report lives at
`/central-oregon-ai/`; the site root redirects to <https://bloom-project.org/>.

## Layout

| Path                           | Role                                                                   |
|--------------------------------|------------------------------------------------------------------------|
| `src/app.js`                   | The app code.                                                          |
| `src/app.css`                  | The styles.                                                            |
| `index.template.html`          | Markup only. The rest is inlined into it at build time.                |
| `data/`                        | JSON data files                                                        |
| `static/`                      | SVG icons.                                                             |
| `build.js`                     | Inlines `src/` and the JSON into the template, writes `dist/`.         |
| `dist/`                        | Build output. Gitignored; regenerated on every deploy.                 |

The build produces one self-contained `index.html` — no external CSS or JS requests —
under `dist/central-oregon-ai/`, with a redirect stub at the `dist/` root:

```
dist/
├── index.html            redirect to bloom-project.org
├── 404.html              same stub, for unmatched paths
└── central-oregon-ai/
    ├── index.html        the report
    └── static/
```

## Local preview

```sh
node build.js && (cd dist && python3 -m http.server 8000)
```
Then open http://localhost:8000/central-oregon-ai/ — not the root, which is the redirect
stub and will send you to bloom-project.org.

