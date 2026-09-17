.PHONY: help test parity icons clean zip

PYTHON ?= python3

help:
	@echo "Snacc PO Raiser"
	@echo
	@echo "  make test    unit tests for the extension's transformation layer"
	@echo "  make parity  diff the JS output against the original pandas pipeline"
	@echo "  make icons   regenerate the extension icons"
	@echo "  make zip     build a shareable snacc-po-raiser.zip"
	@echo "  make clean   remove build artefacts"
	@echo
	@echo "Browser tests (need Chrome, not available in CI):"
	@echo "  open extension/test/run.html as a chrome-extension:// URL and press 'Run all tests'"

test:
	cd extension && node --test "tests/*.test.mjs"

parity:
	$(PYTHON) tools/parity_check.py

icons:
	$(PYTHON) tools/make_icons.py

# Zip the extension for distribution. The zip must contain manifest.json at its
# root, so we zip the *contents* of extension/, not the folder itself.
zip: clean
	@cd extension && zip -qr ../snacc-po-raiser.zip . -x "node_modules/*" "package-lock.json"
	@echo "built snacc-po-raiser.zip ($$(du -h snacc-po-raiser.zip | cut -f1))"
	@echo "recipients: unzip, then chrome://extensions -> Load unpacked"

clean:
	rm -f snacc-po-raiser.zip
	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
	rm -rf extension/node_modules
