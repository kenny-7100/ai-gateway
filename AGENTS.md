# Push workflow

When the user says `push`, immediately run this command sequence:

```sh
git add . && git commit -m 'feat|fix|chore: xxx' && git push
```

Choose exactly one prefix (`feat`, `fix`, or `chore`) and quickly generate a concise commit message from the existing conversation context. Use lowercase wording except for proper names or established uppercase terms. Do not scan files, inspect diffs, run tests, or perform other exploratory work before this sequence.

After the command finishes, briefly report the result. If any step fails, report the failure and stop; do not retry, repair, or run follow-up diagnostic commands unless the user asks.
