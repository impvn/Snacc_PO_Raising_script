# Security

## There is an exposed credential in this repository's history

Commit `882c879` ("Add files via upload") committed a **live SupplyNote password in plain
text**, in two places:

- `Raise_PO_bulk_final.py` — `login(driver, wait, 'Snaccbyswiggy', '…')`
- `Updated_script_to_raise_Purchase_Orders_latest.ipynb` — cell 5

The repository is **public**. The same commit also referenced the path of a Google
service-account key file.

The password has been removed from the working tree, but **removing it from a file does not
remove it from git history.** The commit is immutable and is already on GitHub, so it must be
treated as compromised by anyone who has ever fetched this repo — including bots that scan
public repositories for credentials, which typically find these within hours.

### Do this, in order

1. **Rotate the SupplyNote password now.** This is the only step that actually closes the
   exposure. Sign in to `supplynote.in`, change the password for that account, and update
   wherever the team keeps it (a password manager, not a spreadsheet or a chat message).

2. **Check for unauthorised orders.** While you're in there, look at the order list for
   anything nobody on the team raised. A procurement account can place real orders with real
   vendors, so this is worth five minutes.

3. **Rotate the Google service-account key.** In Google Cloud Console → IAM & Admin → Service
   Accounts → Keys, add a new key and delete the old one. Then re-share only the specific
   spreadsheets with the new service account's email address.

4. **Check whether SupplyNote allows per-user accounts.** The script used one shared login for
   the whole team, which means the platform cannot tell you who raised a given PO, and one
   leaked password compromises everyone. If individual accounts are possible, use them — the
   Chrome extension in `extension/` is built around exactly that, and stores no password at all.

### Optional: purge the history

Rotating the password makes the exposed string worthless, and that is what matters. Purging
history is cosmetic by comparison, and it rewrites every commit SHA — so **do not do this
without telling everyone who has a clone**, since they will need to re-clone.

If you still want to:

```bash
pip install git-filter-repo

# Put the literal exposed password in a local file that is NOT committed, e.g.:
#   printf '%s==>REDACTED\n' "$OLD_PASSWORD" > /tmp/replacements.txt
git filter-repo --replace-text /tmp/replacements.txt
shred -u /tmp/replacements.txt

git push --force --all
```

Do not paste the password into this document, a commit message, or an issue — that just
re-publishes it.

Then, on GitHub: **Settings → Security → Secret scanning** should be enabled, and you may need
to ask GitHub Support to clear cached views of the old commits.

---

## How credentials work now

### The Chrome extension (`extension/`)

**Stores no credentials at all.** It reads the shared spreadsheets using the signed-in user's
Google session and submits orders using their SupplyNote session. There is no password, no API
key, no OAuth client and no service-account file to configure, leak or rotate.

Consequences worth knowing:

- Nothing secret is written to disk, so there is nothing for a lost laptop to expose.
- Every PO is raised under the account of the person who raised it, which gives you a real
  audit trail.
- Access is controlled by the spreadsheet's own sharing settings and by SupplyNote's own
  accounts — both of which you already administer.

### The Python script (`Raise_PO_bulk_final.py`)

Now reads everything from the environment, and prompts if a value is missing:

| Variable | Purpose |
|---|---|
| `SNACC_SERVICE_KEY` | Path to the Google service-account JSON |
| `SNACC_OUTPUT_DIR` | Where generated PO CSVs are written |
| `SNACC_USERNAME` | SupplyNote user id |
| `SNACC_PASSWORD` | SupplyNote password — prompted for via `getpass` if unset |

Copy `.env.example` to `.env` for local use. `.env`, `service-key.json` and any other key
material are git-ignored.

The password prompt uses `getpass`, which does not echo — so it will not appear in screen
recordings, shared screens, or terminal scrollback.

If you schedule this script, put the variables in the scheduler's environment (Task Scheduler,
cron with a `EnvironmentFile`, or a secrets manager) rather than in the script.

---

## Reporting a problem

If you find another exposed credential, **rotate it first, then say something.** Do not open a
public issue describing how to use it.
