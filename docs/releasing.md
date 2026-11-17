# Release a new version

To publish a release, bump the version in `package.json` and push a matching tag:

1. Bump the package version without creating a git tag:

	```bash
	npm version patch --no-git-tag-version
	npm install --package-lock-only
	```

2. Commit the version bump and push `main`:

	```bash
	git commit -am "chore: release vX.Y.Z"
	git push origin main
	```

3. Tag the commit and push the tag:

	```bash
	git tag vX.Y.Z
	git push origin vX.Y.Z
	```

Pushing `vX.Y.Z` triggers `.github/workflows/release.yml`, which runs `npm test` and creates the GitHub release.
