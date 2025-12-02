# Code Health Report

A comprehensive code quality analysis tool that runs multiple linters and analyzers to generate a unified health report for your codebase.

## What It Does

Runs 9 different checks on your codebase:
- **Linting**: oxlint (fast Rust-based linter) + ESLint (import/complexity rules)
- **Dead Code**: knip (unused files, exports, dependencies)
- **Duplicates**: jscpd (code duplication detection)
- **Dependencies**: madge (orphan files, circular dependencies)
- **Types**: TypeScript type checking via turbo
- **Complexity**: File size, hook usage, component patterns
- **Architecture**: dependency-cruiser (module boundaries)
- **Structure**: Folder organization, naming, depth analysis

## Prerequisites

- **Bun** (required - script uses Bun APIs)
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- **Node.js** (for the various npm packages)
- **Turbo** (for type checking - part of your monorepo)

## Required Packages

Install these packages in your project:

```bash
# Core linters and analyzers
bun add -D oxlint knip jscpd madge dependency-cruiser

# ESLint with plugins
bun add -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser

# TypeScript
bun add -D typescript @types/node

# For React projects (if applicable)
bun add -D @types/react @types/react-dom
```

## Configuration Files Needed

The script expects these config files in your project root:

1. **ESLint**: `.eslintrc.js` or similar with import/complexity rules
2. **Knip**: `knip.json` or `knip.ts`
3. **dependency-cruiser**: `.dependency-cruiser.cjs` (for architecture checks)
4. **TypeScript**: `tsconfig.json` in each package/app
5. **Turbo**: `turbo.json` with `check-types` pipeline

### Example Configurations

**knip.json**:
```json
{
  "entry": ["src/index.ts"],
  "project": ["src/**/*.{ts,tsx}"],
  "ignore": ["**/*.test.ts", "**/*.spec.ts"]
}
```

**.dependency-cruiser.cjs**:
```javascript
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true }
    }
  ]
};
```

## Usage

```bash
# Full report (all checks)
bun code-health.ts

# Quick mode (skip slow checks: jscpd, madge, architecture)
bun code-health.ts --quick

# Auto-fix what can be fixed (oxlint --fix)
bun code-health.ts --fix
```

## Output

Generates two files in `logs/` directory:
- `code-health-report.md` - Human-readable markdown report with grades and action items
- `code-health-report.json` - Compact JSON data for programmatic use

## Grade System

- **A**: 0 errors, 0 warnings
- **B**: 0 errors, ≤5 warnings
- **C**: ≤2 errors, ≤15 warnings
- **D**: ≤5 errors
- **F**: >5 errors

## Project Structure Assumptions

The script assumes:
- Monorepo with `apps/` and `packages/` directories
- Frontend code in `apps/web/src/`
- Backend code in `packages/backend/convex/`
- TypeScript/React codebase
- Turbo for build orchestration

Adjust paths in the script if your structure differs.



<img width="412" height="632" alt="image" src="https://github.com/user-attachments/assets/0446f292-260f-4e5e-b0c6-132edcc70303" />


<img width="489" height="1532" alt="image" src="https://github.com/user-attachments/assets/c037291c-38f8-4a00-b2df-3faa7817a9f0" />
