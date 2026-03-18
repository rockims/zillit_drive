# Zillit Drive Revamp Plan

## 1) Current State Summary

### Runtime and stack
- Node + Express API, transpiled with Babel from `src/` to `dist/`.
- API mounted at `/api/v2`.
- Drive domain is split into:
  - routes
  - controllers
  - services
  - repositories
- Domain models are imported from `zillit-libs` (not defined in this repo).

### Active modules in this repo
- `drive folders`: create/get/list/update/delete + folder contents
- `drive files`: create/get/list/update/delete/move + filter by type
- localized public messages

### Key design characteristics
- Soft delete (`deleted_on` timestamp).
- Project/device/user checks are done via `checkAccess` middleware from `zillit-libs`.
- Tool-right checks (view/post) are not explicitly enforced in these routes.
- No folder-level access control (ACL) in current drive models.

## 2) High-Risk Gaps To Fix First

1. Missing folder-level access control
- Any project member passing `checkAccess` can read/write all folders/files in the project.

2. Duplicate protection is inconsistent
- Duplicate checks exist in code but are disabled in create flows.

3. Folder/file domain boundaries are blurry
- Folder create/update behavior depends on `attachments` and toggles `is_folder`, which mixes file semantics into folder APIs.

4. Performance and reliability risks in deep deletions
- Recursive soft delete is N+1 and non-transactional.

5. Quality and maintainability debt
- No tests in this repo.
- Legacy/unused imports and placeholders.
- Health v2 path currently points to v1 health controller behavior.

## 3) Target Architecture

### Access model
- Keep project-level access (`checkAccess`) as baseline.
- Add folder-level ACL:
  - `owner`
  - `editor`
  - `viewer`
- Inheritance:
  - Child folders inherit parent ACL by default.
  - Explicit overrides allowed at folder level.

### Separation of responsibilities
- Folder APIs manage only folder metadata.
- File APIs manage file metadata and placement.
- Permission evaluation centralized in one access service/middleware.

### Data model additions (in `zillit-libs`)
- New collection: `DriveFolderAccessV2`
  - `project_id`
  - `folder_id`
  - `user_id`
  - `role` (`owner|editor|viewer`)
  - `inherited` (boolean)
  - `created_by`, `updated_by`, `created_on`, `updated_on`, `deleted_on`
- Unique index:
  - `(folder_id, user_id, deleted_on)`
- Secondary indexes:
  - `(project_id, user_id, deleted_on)`
  - `(folder_id, role, deleted_on)`

## 4) Folder-Wise Access Rules

### Read rules
- `owner`, `editor`, `viewer` can list/get/read folder and files.
- Non-members of ACL cannot read folder or its children.

### Write rules
- `owner` and `editor` can create subfolders/files, rename/move/update.
- `viewer` cannot mutate content.

### Admin override
- Project admin has full access unless explicitly disabled by business rule.

### Move rules
- Moving folder/file requires:
  - write on source parent
  - write on destination parent
  - read on moved entity

### Delete rules
- Requires write on target folder/file.
- Soft delete remains, but in transaction/batch-safe flow.

## 5) API Changes

### New endpoints
- `GET /api/v2/drive/folders/:folderId/access`
- `PUT /api/v2/drive/folders/:folderId/access`
- `POST /api/v2/drive/folders/:folderId/access/inherit`

### Existing endpoint behavior updates
- All folder/file reads filtered by ACL.
- All folder/file writes checked by ACL before mutation.
- `createFolder` should assign creator as `owner`.

## 6) Execution Plan

### Phase 0 (1-2 days) - Baseline and safety
- Add test framework skeleton and CI command wiring.
- Add contract tests for current folder/file endpoints.
- Add lint/check scripts without auto-fix in CI mode.

### Phase 1 (3-5 days) - Access foundation
- Implement `DriveFolderAccessV2` model and repository in `zillit-libs`.
- Add access service utilities:
  - `assertFolderReadAccess`
  - `assertFolderWriteAccess`
  - `listAccessibleFolderIds`
- Integrate checks into drive folder/file services.

### Phase 2 (2-3 days) - Domain cleanup
- Remove folder `attachments`-driven `is_folder` toggling behavior.
- Re-enable/standardize duplicate checks.
- Add deterministic folder path update strategy on rename/move.

### Phase 3 (2-4 days) - Reliability and scale
- Replace recursive per-item delete with batched/iterative strategy.
- Add pagination and cursor support for folder/file lists.
- Add indexes for list/filter hot paths.

### Phase 4 (2-3 days) - Hardening
- Unit + integration tests for ACL permutations.
- Audit logs for share/revoke/move/delete operations.
- Add metrics and error dashboards for drive endpoints.

## 7) Migration Plan

1. Backfill owner ACL
- For each existing folder, set `created_by` as `owner`.

2. Backfill inherited ACL
- Propagate parent ACL to descendants where no explicit ACL exists.

3. Default root behavior
- For root files/folders with no explicit ACL:
  - decide one policy and run one-time migration:
    - open to all project members, or
    - owner-only.

4. Safe rollout
- Feature flag ACL enforcement.
- Dry-run mode logs deny decisions without blocking.
- Enable blocking after validation window.

## 8) Definition of Done

- Folder/file read/write paths enforce ACL.
- Access endpoints support grant/revoke/list/inherit.
- Existing data migrated with no inaccessible orphan folders.
- Tests cover:
  - owner/editor/viewer permissions
  - move/copy/delete edge cases
  - inheritance overrides
- P95 list/read latency and error rates are within agreed limits.
