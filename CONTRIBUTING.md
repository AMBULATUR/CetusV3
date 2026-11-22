
# Contributing to Cetus 3

Cetus is an open-source WebAssembly analysis workbench for Chrome. Contributions, bug reports, feature suggestions, and documentation improvements are welcome.

## Before contributing

- Check existing issues and pull requests before starting work.
- For major changes, open an issue first to discuss the proposed implementation.
- Keep changes focused and avoid unrelated modifications.
- Do not include copyrighted third-party code without permission.

## Development setup

Requirements:
- Node.js (use the version specified in `.nvmrc`)
- npm
- Google Chrome 120 or newer

Clone the repository:

```bash
git clone https://github.com/AMBULATUR/CetusV3.git
cd CetusV3
npm ci
```

## Build

```bash
npm run build
```

The extension will be generated in `dist/`.

To load it:
1. Open chrome://extensions
2. Enable Developer mode.
3. Select Load unpacked.
4. Select the `dist/` directory.

## Testing

Run the available checks before submitting:

```bash
npm test
npm run typecheck
npm run build
```

End-to-end tests are also available:

```bash
npm run e2e
```

See the README for additional requirements.

## Pull requests

1. Fork the repository.
2. Create a descriptive branch.
3. Make your changes.
4. Run relevant tests.
5. Submit a pull request against `main`.
6. Explain what changed and why.

## Code guidelines

- Follow the existing TypeScript coding style.
- Keep WebAssembly parsing and rewriting changes compatible with existing functionality.
- Avoid unnecessary dependencies.
- Handle unsupported WebAssembly features gracefully.
- Add or update tests when appropriate.
- Do not commit generated files, dependencies, or local configuration.

## Questions

For bugs and feature requests, use GitHub Issues.

Thank you for helping improve Cetus 3!
