# API examples: an end-to-end flow with curl

This walks through the whole v1 data flow: users and tokens, scholarly records, chunks,
embeddings, search, a clustering run, labels, reviews and provenance. The API only
**records** what external tools did; the vectors, clusters and labels below stand in for
the output of real embedding, clustering and labelling scripts.

The example corpus fits an Evangelical-Lutheran research setting: article IV of the
Augsburg Confession (1530), which has two authoritative originals (Latin and German), and a
contemporary Finnish sermon for the 3rd Sunday after Epiphany (*3. sunnuntai loppiaisesta*).
The sermon, its preacher and its text are fictional examples; the confession texts are short
excerpts in normalised spelling.

The OpenAPI document of the running server is at `/docs` (Swagger UI) and `/docs/json`.

## 0. Setup

```sh
export DATABASE_URL=postgres://sermonize:sermonize@localhost:5432/sermonize
npm run migrate
npm run dev &                      # http://127.0.0.1:3000

# Bootstrap an admin with the CLI (writes as the fixed system user).
ADMIN_ID=$(npm run -s cli -- create-user --kind human --role admin --email admin@example.org)
ADMIN=$(npm run -s cli -- create-token --user "$ADMIN_ID" --name laptop)

API=http://127.0.0.1:3000
# call <token> <METHOD> <path> [json body]
call() { curl -sS -X "$2" "$API$3" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' ${4:+-d "$4"}; }

call "$ADMIN" GET /me
# {"user_id":"…","role":"admin","kind":"human"}
```

Create the principals used below through the admin API. A `service` user is what an external
processing script uses; a `curator` reviews labels. E-mail and display name go to the
`private` schema and are never returned.

```sh
PIPE_ID=$(call "$ADMIN" POST /admin/users '{"kind":"service","role":"contributor"}' | jq -r .id)
PIPE=$(call "$ADMIN" POST "/admin/users/$PIPE_ID/tokens" '{"name":"embedding-pipeline"}' | jq -r .token)

CUR_ID=$(call "$ADMIN" POST /admin/users '{"kind":"human","role":"curator","display_name":"Kuraattori"}' | jq -r .id)
CUR=$(call "$ADMIN" POST "/admin/users/$CUR_ID/tokens" '{"name":"review"}' | jq -r .token)

READER_ID=$(call "$ADMIN" POST /admin/users '{"kind":"human","role":"reader"}' | jq -r .id)
READER=$(call "$ADMIN" POST "/admin/users/$READER_ID/tokens" '{"name":"research"}' | jq -r .token)
```

## 1. Scholarly records

Persons, a work with its authors, and an edition as the source.

```sh
MEL=$(call "$PIPE" POST /persons '{
  "display_name": "Philipp Melanchthon",
  "name_variants": ["Philippus Melanchthon", "Philipp Schwartzerdt"],
  "year_from": 1497, "year_to": 1560
}' | jq -r .id)

CA=$(call "$PIPE" POST /works "{
  \"title\": \"Confessio Augustana\",
  \"title_variants\": [\"Augsburger Bekenntnis\", \"Augsburgin tunnustus\"],
  \"genre\": \"confession\",
  \"original_languages\": [\"la\", \"de\"],
  \"year_from\": 1530, \"year_to\": 1530,
  \"persons\": [{\"person_id\": \"$MEL\", \"role\": \"author\", \"certainty\": \"certain\"}]
}" | jq -r .id)

BSELK=$(call "$PIPE" POST /sources '{
  "kind": "print_edition",
  "citation": "Die Bekenntnisschriften der Evangelisch-Lutherischen Kirche. Vollständige Neuedition, hg. von Irene Dingel. Göttingen: Vandenhoeck & Ruprecht, 2014.",
  "title": "Die Bekenntnisschriften der Evangelisch-Lutherischen Kirche",
  "editor": "Irene Dingel", "publisher": "Vandenhoeck & Ruprecht", "place": "Göttingen", "year": 2014,
  "access_level": "public"
}' | jq -r .id)
```

Article IV has **two originals**: both texts belong directly to the work, neither is a
translation of the other. Bodies must be NFC-normalised and use `\n` line endings; they are
immutable once stored (corrections are new texts with `supersedes_text_id`).

```sh
CA_LA=$(call "$PIPE" POST /texts "{
  \"work_id\": \"$CA\", \"source_id\": \"$BSELK\", \"language\": \"la\", \"relation\": \"original\",
  \"coverage\": \"excerpt\", \"coverage_note\": \"CA IV (De iustificatione)\",
  \"year_from\": 1530, \"year_to\": 1530, \"title\": \"CA IV (lat.)\",
  \"body\": \"Item docent, quod homines non possint iustificari coram Deo propriis viribus, meritis aut operibus, sed gratis iustificentur propter Christum per fidem, cum credunt se in gratiam recipi et peccata remitti propter Christum, qui sua morte pro nostris peccatis satisfecit.\nHanc fidem imputat Deus pro iustitia coram ipso, Rom. 3 et 4.\"
}" | jq -r .id)

CA_DE=$(call "$PIPE" POST /texts "{
  \"work_id\": \"$CA\", \"source_id\": \"$BSELK\", \"language\": \"de\", \"relation\": \"original\",
  \"coverage\": \"excerpt\", \"coverage_note\": \"CA IV (Von der Rechtfertigung)\",
  \"year_from\": 1530, \"year_to\": 1530, \"title\": \"CA IV (dt.)\",
  \"body\": \"Weiter wird gelehrt, dass wir Vergebung der Sünde und Gerechtigkeit vor Gott nicht erlangen mögen durch unser Verdienst, Werk und Genugtun, sondern dass wir Vergebung der Sünde bekommen und vor Gott gerecht werden aus Gnaden um Christus willen durch den Glauben.\nDenn diesen Glauben will Gott für Gerechtigkeit vor ihm halten und zurechnen, wie St. Paulus sagt zu den Römern im 3. und 4.\"
}" | jq -r .id)

call "$READER" GET "/texts/$CA_LA"                      # metadata, content_sha256, char_length (331)
call "$READER" GET "/texts/$CA_LA/body?start=0&end=37"  # {"content":"Item docent, quod homines non possint",…}
```

A contemporary Finnish sermon. Preachers are research-subject data (not account PII). The text
came directly from its author and is licensed for research only, so the **source** is
`restricted`: the effective access level of the text is the most restrictive of text and source.

```sh
PREACHER=$(call "$PIPE" POST /persons '{"display_name": "Esimerkki Saarnaaja", "is_living": true}' | jq -r .id)

SERMON=$(call "$PIPE" POST /works "{
  \"title\": \"Sano vain sana\",
  \"genre\": \"sermon\", \"original_languages\": [\"fi\"], \"year_from\": 2024, \"year_to\": 2024,
  \"persons\": [{\"person_id\": \"$PREACHER\", \"role\": \"author\"}],
  \"occasion\": {
    \"preached_on\": \"2024-01-21\",
    \"church_year_day\": \"3. sunnuntai loppiaisesta\",
    \"lectionary\": \"ELCF evankeliumikirja 2000\",
    \"lectionary_year\": \"I\",
    \"pericopes\": [\"Matt. 8:5-13\"],
    \"place\": \"Esimerkkilän kirkko\"
  }
}" | jq -r .id)

SUBMISSION=$(call "$PIPE" POST /sources '{
  "kind": "author_submission",
  "citation": "Saarnakäsikirjoitus, toimitettu tutkimuskäyttöön 2024.",
  "license": "research use only", "access_level": "restricted"
}' | jq -r .id)

SERMON_TEXT=$(call "$PIPE" POST /texts "{
  \"work_id\": \"$SERMON\", \"source_id\": \"$SUBMISSION\", \"language\": \"fi\", \"relation\": \"original\",
  \"year_from\": 2024, \"year_to\": 2024,
  \"body\": \"Sadanpäämies sanoi: ”Herra, en ole sen arvoinen, että tulisit kattoni alle. Sano vain sana, niin palvelijani paranee.”\nUsko ei ole meidän ansiotamme vaan Jumalan lahja. Kristus tulee sinne, missä häntä ei ansaita.\"
}" | jq -r .id)

call "$READER" GET "/texts/$SERMON_TEXT" | jq .effective_access_level    # "restricted"
call "$READER" GET "/texts/$SERMON_TEXT/body"                            # 403 for readers
```

## 2. Segmentations and chunks

A segmentation records *how* a text was chunked (`producer` is required). Chunk offsets are
Unicode **code points**, half-open `[start, end)`; the server checks that each chunk's `text`
is exactly that substring of the body. Batches are all-or-nothing and idempotent on
`(segmentation, sequence)`: a retry returns `skipped`, different content returns 409.

```sh
PRODUCER='{"tool": "sermonize-chunker", "version": "0.4.1", "commit": "9f3c2e1", "parameters": {"split": "paragraph"}}'

SEG_LA=$(call "$PIPE" POST /segmentations "{\"text_id\": \"$CA_LA\", \"method\": \"paragraph\", \"producer\": $PRODUCER}" | jq -r .id)
call "$PIPE" POST "/segmentations/$SEG_LA/chunks" '[
  {"sequence": 0, "start_offset": 0, "end_offset": 269, "locus": "CA IV,1-2",
   "text": "Item docent, quod homines non possint iustificari coram Deo propriis viribus, meritis aut operibus, sed gratis iustificentur propter Christum per fidem, cum credunt se in gratiam recipi et peccata remitti propter Christum, qui sua morte pro nostris peccatis satisfecit."},
  {"sequence": 1, "start_offset": 270, "end_offset": 331, "locus": "CA IV,3",
   "text": "Hanc fidem imputat Deus pro iustitia coram ipso, Rom. 3 et 4."}
]'
# {"inserted":2,"skipped":0}   (the same request again: {"inserted":0,"skipped":2})

SEG_DE=$(call "$PIPE" POST /segmentations "{\"text_id\": \"$CA_DE\", \"method\": \"paragraph\", \"producer\": $PRODUCER}" | jq -r .id)
call "$PIPE" POST "/segmentations/$SEG_DE/chunks" '[
  {"sequence": 0, "start_offset": 0, "end_offset": 262, "locus": "CA IV,1-2",
   "text": "Weiter wird gelehrt, dass wir Vergebung der Sünde und Gerechtigkeit vor Gott nicht erlangen mögen durch unser Verdienst, Werk und Genugtun, sondern dass wir Vergebung der Sünde bekommen und vor Gott gerecht werden aus Gnaden um Christus willen durch den Glauben."},
  {"sequence": 1, "start_offset": 263, "end_offset": 387, "locus": "CA IV,3",
   "text": "Denn diesen Glauben will Gott für Gerechtigkeit vor ihm halten und zurechnen, wie St. Paulus sagt zu den Römern im 3. und 4."}
]'

SEG_FI=$(call "$PIPE" POST /segmentations "{\"text_id\": \"$SERMON_TEXT\", \"method\": \"paragraph\", \"producer\": $PRODUCER}" | jq -r .id)
call "$PIPE" POST "/segmentations/$SEG_FI/chunks" '[
  {"sequence": 0, "start_offset": 0, "end_offset": 118,
   "text": "Sadanpäämies sanoi: ”Herra, en ole sen arvoinen, että tulisit kattoni alle. Sano vain sana, niin palvelijani paranee.”"},
  {"sequence": 1, "start_offset": 119, "end_offset": 213,
   "text": "Usko ei ole meidän ansiotamme vaan Jumalan lahja. Kristus tulee sinne, missä häntä ei ansaita."}
]'

# Chunk ids, in sequence order
LA0=$(call "$PIPE" GET "/segmentations/$SEG_LA/chunks" | jq -r '.items[0].id'); LA1=$(call "$PIPE" GET "/segmentations/$SEG_LA/chunks" | jq -r '.items[1].id')
DE0=$(call "$PIPE" GET "/segmentations/$SEG_DE/chunks" | jq -r '.items[0].id'); DE1=$(call "$PIPE" GET "/segmentations/$SEG_DE/chunks" | jq -r '.items[1].id')
FI0=$(call "$PIPE" GET "/segmentations/$SEG_FI/chunks" | jq -r '.items[0].id'); FI1=$(call "$PIPE" GET "/segmentations/$SEG_FI/chunks" | jq -r '.items[1].id')
```

A wrong offset is rejected with the failing items listed, and nothing is inserted:

```sh
call "$PIPE" POST "/segmentations/$SEG_LA/chunks" '[{"sequence": 2, "start_offset": 0, "end_offset": 4, "text": "Idem"}]'
# 422 {"error":{"code":"validation_failed","details":{"failed":1,"errors":[{"index":0,"sequence":2,"reason":"text_mismatch",…}]}}}
```

## 3. Embedding space, embeddings and search

An embedding space pins down everything that makes vectors comparable (model, revision,
prefixes, normalisation, metric). The 4-dimensional space here keeps the example short; a real
multilingual model would have e.g. 1024 dimensions.

```sh
SPACE=$(call "$PIPE" POST /embedding-spaces '{
  "name": "demo-multilingual-4d-v1",
  "model": "example/multilingual-embedder", "revision": "2026-01-15",
  "dimensions": 4, "metric": "cosine", "normalized": true, "is_multilingual": true,
  "document_prefix": "passage: ", "query_prefix": "query: ", "max_tokens": 512,
  "producer": {"tool": "sermonize-embed", "version": "1.0.0"}
}' | jq -r .id)

call "$PIPE" POST "/embedding-spaces/$SPACE/embeddings" "[
  {\"chunk_id\": \"$LA0\", \"vector\": [0.8, 0.6, 0, 0]},
  {\"chunk_id\": \"$DE0\", \"vector\": [0.6, 0.8, 0, 0]},
  {\"chunk_id\": \"$FI1\", \"vector\": [0.6, 0.6, 0.529150262, 0]},
  {\"chunk_id\": \"$LA1\", \"vector\": [0, 0, 0.6, 0.8]},
  {\"chunk_id\": \"$DE1\", \"vector\": [0, 0, 0.8, 0.6]},
  {\"chunk_id\": \"$FI0\", \"vector\": [0, 0.6, 0, 0.8]}
]"
# {"inserted":6,"skipped":0}

# Operators can build the per-space HNSW index (optional; search works without it):
# OWNER_DATABASE_URL=… npm run -s cli -- create-index "$SPACE"
```

The caller embeds the query itself (with the space's `query_prefix`) and sends the vector.
Readers get public chunks only; contributors may ask for restricted ones.

```sh
call "$READER" POST /search "{
  \"embedding_space_id\": \"$SPACE\", \"vector\": [0.75, 0.66, 0, 0], \"limit\": 5,
  \"filters\": {\"genre\": \"confession\", \"year_from\": 1500, \"year_to\": 1600}
}" | jq '.items[] | {distance, lang: .chunk.language, locus: .chunk.locus, work: .work.title}'

call "$PIPE" POST /search "{
  \"embedding_space_id\": \"$SPACE\", \"vector\": [0.75, 0.66, 0, 0],
  \"filters\": {\"language\": \"fi\", \"include_restricted\": true}
}" | jq '.items[] | {distance, text: .chunk.text}'
```

## 4. A clustering run

A run is created `open`, filled in several requests, then marked `complete`, which freezes it.
Post clusters first, then **all** memberships (the full input set; `cluster_number: null` = noise).
Both batches are idempotent like chunks. Parents may appear in the same batch as their children.

```sh
RUN=$(call "$PIPE" POST /clustering-runs "{
  \"embedding_space_id\": \"$SPACE\", \"algorithm\": \"hdbscan\",
  \"parameters\": {\"min_cluster_size\": 2, \"min_samples\": 1, \"cluster_selection_method\": \"eom\"},
  \"input_filter\": {\"note\": \"all chunks of the demo corpus\"},
  \"producer\": {\"tool\": \"sermonize-cluster\", \"version\": \"0.2.0\", \"commit\": \"4be1d0a\"}
}" | jq -r .id)

call "$PIPE" POST "/clustering-runs/$RUN/clusters" '[
  {"cluster_number": 0, "centroid": [0.67, 0.67, 0.18, 0], "metadata": {"persistence": 0.41}},
  {"cluster_number": 1, "centroid": [0, 0, 0.7, 0.7]}
]'

call "$PIPE" POST "/clustering-runs/$RUN/memberships" "[
  {\"embedding_id\": \"$(call "$PIPE" GET "/chunks/$LA0?include_embeddings=true" | jq -r '.embeddings[0].id')\", \"cluster_number\": 0, \"score\": 0.97},
  {\"embedding_id\": \"$(call "$PIPE" GET "/chunks/$DE0?include_embeddings=true" | jq -r '.embeddings[0].id')\", \"cluster_number\": 0, \"score\": 0.95},
  {\"embedding_id\": \"$(call "$PIPE" GET "/chunks/$FI1?include_embeddings=true" | jq -r '.embeddings[0].id')\", \"cluster_number\": 0, \"score\": 0.71},
  {\"embedding_id\": \"$(call "$PIPE" GET "/chunks/$LA1?include_embeddings=true" | jq -r '.embeddings[0].id')\", \"cluster_number\": 1, \"score\": 0.93},
  {\"embedding_id\": \"$(call "$PIPE" GET "/chunks/$DE1?include_embeddings=true" | jq -r '.embeddings[0].id')\", \"cluster_number\": 1, \"score\": 0.93},
  {\"embedding_id\": \"$(call "$PIPE" GET "/chunks/$FI0?include_embeddings=true" | jq -r '.embeddings[0].id')\", \"cluster_number\": null}
]"
# {"inserted":6,"skipped":0}

call "$PIPE" POST "/clustering-runs/$RUN/complete" '{}' | jq '{status, completed_at, cluster_count, input_size, noise_count}'
# {"status":"complete",…,"cluster_count":2,"input_size":6,"noise_count":1}
```

`complete` fills each cluster's `size` from the memberships (members of the cluster and its
descendants); a client-supplied `size` that disagrees is a 409 listing the clusters. After
completion nothing can be added:

```sh
call "$PIPE" POST "/clustering-runs/$RUN/clusters" '[{"cluster_number": 2}]'
# 409 {"error":{"code":"conflict","message":"clustering run is complete; clusters and memberships can only be added while it is open"}}
```

Readers list complete runs (the default filter); `?status=open|withdrawn|all` needs contributor+.

```sh
call "$READER" GET "/clustering-runs?embedding_space_id=$SPACE"
C0=$(call "$READER" GET "/clustering-runs/$RUN/clusters" | jq -r '.items[] | select(.cluster_number == 0) | .id')
call "$READER" GET "/clusters/$C0"
call "$READER" GET "/clusters/$C0/members" | jq '.items[] | {score, locus: .chunk.locus, restricted: .chunk.restricted, text: .chunk.text}'
# the Finnish sermon chunk is listed with "restricted": true and "text": null for readers
```

## 5. Labels and reviews

Labels are research metadata about a cluster *under this method*, not doctrinal judgements.
A model label needs `model` and `producer`; labels are immutable, so a human revision is a new
label that supersedes the old one.

```sh
L1=$(call "$PIPE" POST "/clusters/$C0/labels" '{
  "language": "fi",
  "label": "Vanhurskauttaminen",
  "description": "Ihminen vanhurskautetaan Kristuksen tähden uskon kautta, ei omien tekojen perusteella.",
  "producer_kind": "model", "model": "example/label-llm", "model_version": "2026-03",
  "producer": {"tool": "sermonize-label", "version": "0.1.0", "parameters": {"temperature": 0}}
}' | jq -r .id)

# Curators review (reviewer_id is always the caller).
call "$CUR" POST "/labels/$L1/reviews" '{"decision": "needs_revision", "note": "Liian yleinen: klusteri korostaa armoa lahjana."}'

L2=$(call "$CUR" POST "/clusters/$C0/labels" "{
  \"language\": \"la\", \"label\": \"Iustificatio gratis propter Christum per fidem\",
  \"producer_kind\": \"human\", \"supersedes_label_id\": \"$L1\"
}" | jq -r .id)
call "$CUR" POST "/labels/$L2/reviews" '{"decision": "accepted"}'

call "$READER" GET "/clusters/$C0/labels" | jq '.items[] | {label, status, superseded}'
# {"label":"Vanhurskauttaminen","status":"needs_revision","superseded":true}
# {"label":"Iustificatio gratis propter Christum per fidem","status":"accepted","superseded":false}
```

## 6. Provenance

The whole chain for a chunk: segmentation (producer) → text (hash, persons) → source → work
(authors, occasion) → persons, plus its embeddings (space summaries) and cluster memberships.

```sh
call "$READER" GET "/chunks/$LA0/provenance" | jq '{
  locus: .chunk.locus, sha: .chunk.content_sha256,
  chunker: .segmentation.producer, edition: .source.citation,
  work: .work.title, authors: [.work.persons[] | .display_name],
  spaces: [.embeddings[] | .embedding_space.name], clusters: .cluster_memberships
}'

call "$READER" GET "/chunks/$FI1/provenance" | jq '{text: .chunk.text, occasion: .work.occasion}'
# restricted chunk: "text": null for readers; the metadata (occasion, source, license) stays visible
```

And for a cluster: the run (algorithm, parameters, producer, status), the embedding space, the
size of the input set, noise and cluster counts, and every label with its reviews (reviewer ids
only).

```sh
call "$READER" GET "/clusters/$C0/provenance" | jq '{
  run: .run | {algorithm, parameters, producer, status, completed_at},
  space: .embedding_space | {name, model, revision, metric},
  input: .input,
  labels: [.labels[] | {label, status, superseded, reviews: [.reviews[] | {decision, reviewer_id}]}]
}'
```

## 7. Withdrawing a run

A curator can withdraw an open or complete run (with a reason). It stays stored for provenance
but disappears from readers' lists, and its labels can no longer be reviewed.

```sh
call "$CUR" POST "/clustering-runs/$RUN/withdraw" '{"reason": "input filter excluded the German originals by mistake"}'
call "$READER" GET "/clusters/$C0"          # 403: withdrawn runs need contributor+
```
