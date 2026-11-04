# Project templates

`phi init` lists every folder here that has a `template.json`, sorted by `order`:

```json
{ "name": "Thesis", "description": "Chapters in separate files", "order": 4 }
```

Everything else in the folder (subfolders included) is copied into the new project, except
`template.json`. Existing files in the project are never overwritten. To install a downloaded
template, replace the folder's files and keep its `template.json`.

## Licenses

Templates are published with Phi, so a template you add must be redistributable. Put its
license (and its author's notice, if the license asks for one) in the template folder, e.g.
`templates/thesis/LICENSE`. The bundled placeholders are part of Phi and under its MIT license.
