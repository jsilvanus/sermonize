import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, setupTestApp, type TestContext, type TestUser } from './helpers.js';

describe('persons and works', () => {
  let ctx: TestContext;
  let reader: TestUser;
  let contributor: TestUser;
  let curator: TestUser;
  const tag = `t${Date.now().toString(36)}`; // makes names unique per run

  beforeAll(async () => {
    ctx = await setupTestApp();
    reader = await createUser(ctx.pool, { role: 'reader' });
    contributor = await createUser(ctx.pool, { role: 'contributor' });
    curator = await createUser(ctx.pool, { role: 'curator' });
  });
  afterAll(() => ctx.close());

  const post = (user: TestUser, url: string, payload: object) => api(ctx.app, user, { method: 'POST', url, payload });
  const get = (user: TestUser, url: string) => api(ctx.app, user, { method: 'GET', url });
  const patch = (user: TestUser, url: string, payload: object) => api(ctx.app, user, { method: 'PATCH', url, payload });
  const put = (user: TestUser, url: string, payload: unknown) =>
    api(ctx.app, user, { method: 'PUT', url, payload: payload as object });

  async function createPerson(body: object = {}) {
    const res = await post(contributor, '/persons', { display_name: `Person ${tag}`, ...body });
    expect(res.statusCode).toBe(201);
    return res.json();
  }
  async function createWork(body: object = {}) {
    const res = await post(contributor, '/works', { title: `Work ${tag}`, genre: 'treatise', ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  describe('persons', () => {
    it('creates, ignores server-owned fields, and gets by id', async () => {
      const res = await post(contributor, '/persons', {
        display_name: 'Augustinus Hipponensis',
        name_variants: ['Augustine of Hippo', `Aurelius ${tag}`],
        year_from: 354,
        year_to: 430,
        external_ids: { wikidata: 'Q8018' },
        created_by: curator.id,
        updated_by: curator.id,
        withdrawn_at: '2020-01-01T00:00:00Z',
        withdrawn_by: curator.id,
        unknown_field: 'ignored',
      });
      expect(res.statusCode).toBe(201);
      const p = res.json();
      expect(p).toMatchObject({
        display_name: 'Augustinus Hipponensis',
        name_variants: ['Augustine of Hippo', `Aurelius ${tag}`],
        is_living: null,
        year_from: 354,
        year_to: 430,
        external_ids: { wikidata: 'Q8018' },
        metadata: {},
        withdrawn_at: null,
        withdrawn_by: null,
        created_by: contributor.id,
        updated_by: contributor.id,
      });
      expect(p).not.toHaveProperty('unknown_field');
      expect(p.created_at).toMatch(/Z$/);

      const got = await get(reader, `/persons/${p.id}`);
      expect(got.statusCode).toBe(200);
      expect(got.json()).toEqual(p);
    });

    it('accepts a client-supplied id and rejects a duplicate with 409', async () => {
      const id = crypto.randomUUID();
      expect((await post(contributor, '/persons', { id, display_name: 'X' })).json().id).toBe(id);
      const dup = await post(contributor, '/persons', { id, display_name: 'X' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('conflict');
    });

    it('validates input', async () => {
      expect((await post(contributor, '/persons', {})).statusCode).toBe(400);
      expect((await post(contributor, '/persons', { display_name: 'A', year_from: 'x' })).statusCode).toBe(400);
      expect((await post(contributor, '/persons', { display_name: 'A', metadata: [1] })).statusCode).toBe(400);
      const range = await post(contributor, '/persons', { display_name: 'A', year_from: 500, year_to: 400 });
      expect(range.statusCode).toBe(422);
      expect((await post(contributor, '/persons', { display_name: '   ' })).statusCode).toBe(422);
    });

    it('enforces roles: readers cannot create, contributors cannot patch or withdraw', async () => {
      expect((await post(reader, '/persons', { display_name: 'A' })).statusCode).toBe(403);
      const p = await createPerson();
      expect((await patch(contributor, `/persons/${p.id}`, { date_note: 'x' })).statusCode).toBe(403);
      expect((await post(contributor, `/persons/${p.id}/withdraw`, { reason: 'dup' })).statusCode).toBe(403);
      expect((await api(ctx.app, null, { method: 'GET', url: `/persons/${p.id}` })).statusCode).toBe(401);
    });

    it('PATCH updates whitelisted fields and writes an audit row with only the changes', async () => {
      const p = await createPerson({ year_from: 1483 });
      const res = await patch(curator, `/persons/${p.id}`, {
        date_note: 'born in Eisleben',
        year_to: 1546,
        created_by: reader.id,
        id: crypto.randomUUID(),
      });
      expect(res.statusCode).toBe(200);
      const updated = res.json();
      expect(updated).toMatchObject({ id: p.id, date_note: 'born in Eisleben', year_to: 1546, created_by: contributor.id });
      expect(updated.updated_by).toBe(curator.id);

      const audit = await ctx.pool.query(
        `SELECT action, actor_id, request_id, changes FROM audit_event
          WHERE entity_type = 'person' AND entity_id = $1 ORDER BY occurred_at, id`,
        [p.id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['insert', 'update']);
      expect(audit.rows[1].actor_id).toBe(curator.id);
      expect(audit.rows[1].request_id).toBe(res.headers['x-request-id']);
      expect(audit.rows[1].changes).toEqual({
        date_note: { old: null, new: 'born in Eisleben' },
        year_to: { old: null, new: 1546 },
      });
    });

    it('PATCH with no updatable fields is a 400, unknown id a 404', async () => {
      const p = await createPerson();
      expect((await patch(curator, `/persons/${p.id}`, { created_by: reader.id })).statusCode).toBe(400);
      expect((await patch(curator, `/persons/${crypto.randomUUID()}`, { date_note: 'x' })).statusCode).toBe(404);
    });

    it('withdraws; withdrawn records are hidden from lists unless include_withdrawn', async () => {
      const p = await createPerson({ display_name: `Withdrawn ${tag}` });
      const w = await post(curator, `/persons/${p.id}/withdraw`, { reason: 'duplicate record' });
      expect(w.statusCode).toBe(200);
      expect(w.json()).toMatchObject({ withdrawn_by: curator.id, withdrawn_reason: 'duplicate record' });
      expect(w.json().withdrawn_at).not.toBeNull();
      expect((await post(curator, `/persons/${p.id}/withdraw`, { reason: 'again' })).statusCode).toBe(409);
      expect((await post(curator, `/persons/${p.id}/withdraw`, {})).statusCode).toBe(400);

      const audit = await ctx.pool.query(
        `SELECT action FROM audit_event WHERE entity_type = 'person' AND entity_id = $1 ORDER BY occurred_at, id`,
        [p.id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['insert', 'withdraw']);

      const q = encodeURIComponent(`Withdrawn ${tag}`);
      expect((await get(reader, `/persons?q=${q}`)).json().items).toEqual([]);
      const all = await get(reader, `/persons?q=${q}&include_withdrawn=true`);
      expect(all.json().items.map((x: { id: string }) => x.id)).toEqual([p.id]);
      expect((await get(reader, `/persons/${p.id}`)).json().withdrawn_reason).toBe('duplicate record');
    });

    it('filters by name (display name and variants, case-insensitive, wildcards literal)', async () => {
      const a = await createPerson({ display_name: `Johannes Chrysostomos ${tag}` });
      const b = await createPerson({ display_name: `Golden Mouth`, name_variants: [`CHRYSOSTOM ${tag}`] });
      await createPerson({ display_name: `Basil ${tag}` });
      const res = await get(reader, `/persons?q=${encodeURIComponent(`chrysostom`)}&limit=500`);
      const ids = res.json().items.map((x: { id: string }) => x.id);
      expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(res.json().items.every((x: { display_name: string; name_variants: string[] }) =>
        [x.display_name, ...x.name_variants].some((n) => /chrysostom/i.test(n)),
      )).toBe(true);
      expect((await get(reader, `/persons?q=${encodeURIComponent('%')}`)).json().items).toEqual([]);
    });

    it('paginates with an opaque cursor', async () => {
      const name = `Paged ${tag}`;
      const created: string[] = [];
      for (let i = 0; i < 5; i++) created.push((await createPerson({ display_name: `${name} ${i}` })).id);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/persons?q=${encodeURIComponent(name)}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await get(reader, url);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.items.length).toBeLessThanOrEqual(2);
        seen.push(...body.items.map((x: { id: string }) => x.id));
        cursor = body.next_cursor;
        pages++;
      } while (cursor);
      // Keyset order is id order (UUIDv7: time-ordered, but random within one millisecond).
      expect(seen).toEqual([...created].sort());
      expect(pages).toBe(3);
      expect((await get(reader, '/persons?cursor=garbage')).statusCode).toBe(400);
      expect((await get(reader, '/persons?limit=501')).statusCode).toBe(400);
      expect((await get(reader, '/persons?limit=0')).statusCode).toBe(400);
    });
  });

  describe('works', () => {
    it('creates a work with persons and gets it with nested persons', async () => {
      const author = await createPerson({ display_name: `Author ${tag}` });
      const compiler = await createPerson({ display_name: `Compiler ${tag}` });
      const res = await post(contributor, '/works', {
        title: 'Confessiones',
        title_variants: ['Confessions'],
        genre: 'treatise',
        original_languages: ['la'],
        year_from: 397,
        year_to: 400,
        date_note: 'c. 397-400',
        external_ids: { cpl: '251' },
        persons: [
          { person_id: author.id, role: 'author' },
          { person_id: compiler.id, role: 'compiler', certainty: 'disputed', note: 'late attribution' },
        ],
        created_by: curator.id,
      });
      expect(res.statusCode, res.body).toBe(201);
      const w = res.json();
      expect(w).toMatchObject({
        title: 'Confessiones',
        genre: 'treatise',
        original_languages: ['la'],
        part_of_work_id: null,
        created_by: contributor.id,
        occasion: null,
      });
      expect(w.persons).toEqual([
        { person_id: author.id, display_name: author.display_name, role: 'author', certainty: 'certain', note: null },
        { person_id: compiler.id, display_name: compiler.display_name, role: 'compiler', certainty: 'disputed', note: 'late attribution' },
      ]);
      expect((await get(reader, `/works/${w.id}`)).json()).toEqual(w);
    });

    it('original_languages may be null (unknown)', async () => {
      const w = await createWork({ original_languages: null });
      expect(w.original_languages).toBeNull();
    });

    it('validates genre, unknown persons and duplicates', async () => {
      expect((await post(contributor, '/works', { title: 'x', genre: 'novel' })).statusCode).toBe(400);
      const unknown = await post(contributor, '/works', {
        title: 'x',
        genre: 'letter',
        persons: [{ person_id: crypto.randomUUID(), role: 'author' }],
      });
      expect(unknown.statusCode).toBe(422);
      const p = await createPerson();
      const dup = await post(contributor, '/works', {
        title: 'x',
        genre: 'letter',
        persons: [
          { person_id: p.id, role: 'author' },
          { person_id: p.id, role: 'author' },
        ],
      });
      expect(dup.statusCode).toBe(400);
      expect((await post(contributor, '/works', { title: 'x', genre: 'letter', original_languages: ['not a tag'] })).statusCode).toBe(400);
    });

    it('PUT /works/:id/persons replaces the set (curator only) and audits only changes', async () => {
      const a = await createPerson();
      const b = await createPerson();
      const c = await createPerson();
      const w = await createWork({
        persons: [
          { person_id: a.id, role: 'author' },
          { person_id: b.id, role: 'attributed_author', certainty: 'probable' },
        ],
      });
      expect((await put(contributor, `/works/${w.id}/persons`, [])).statusCode).toBe(403);

      const res = await put(curator, `/works/${w.id}/persons`, [
        { person_id: a.id, role: 'author' }, // unchanged
        { person_id: b.id, role: 'attributed_author', certainty: 'spurious' }, // updated
        { person_id: c.id, role: 'compiler' }, // added
      ]);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().persons.map((x: { person_id: string; certainty: string }) => [x.person_id, x.certainty])).toEqual(
        expect.arrayContaining([
          [a.id, 'certain'],
          [b.id, 'spurious'],
          [c.id, 'certain'],
        ]),
      );
      const removed = await put(curator, `/works/${w.id}/persons`, [{ person_id: c.id, role: 'compiler' }]);
      expect(removed.json().persons.map((x: { person_id: string }) => x.person_id)).toEqual([c.id]);

      const audit = await ctx.pool.query(
        `SELECT action, changes FROM audit_event WHERE entity_type = 'work_person' AND entity_id = $1 ORDER BY occurred_at, id`,
        [w.id],
      );
      // (ids of events written in the same millisecond are not ordered, so compare as a multiset)
      expect(audit.rows.map((r) => r.action).sort()).toEqual(['delete', 'delete', 'insert', 'insert', 'insert', 'update']);
      expect(audit.rows.find((r) => r.action === 'update')!.changes).toEqual({
        certainty: { old: 'probable', new: 'spurious' },
      });

      expect((await put(curator, `/works/${crypto.randomUUID()}/persons`, [])).statusCode).toBe(404);
    });

    it('sermon occasion: only for sermons, full replace via PUT', async () => {
      const notSermon = await post(contributor, '/works', {
        title: 'x',
        genre: 'treatise',
        occasion: { church_year_day: 'x' },
      });
      expect(notSermon.statusCode).toBe(422);
      expect(notSermon.json().error.message).toMatch(/genre sermon/);

      const sermon = await createWork({
        genre: 'sermon',
        occasion: {
          preached_on: '2024-01-21',
          church_year_day: '3. sunnuntai loppiaisesta',
          lectionary: 'ELCF evankeliumikirja 2000',
          lectionary_year: 'II',
          pericopes: ['Matt. 8:1-13'],
          place: 'Riihimäki',
        },
      });
      expect(sermon.occasion).toEqual({
        preached_on: '2024-01-21',
        church_year_day: '3. sunnuntai loppiaisesta',
        lectionary: 'ELCF evankeliumikirja 2000',
        lectionary_year: 'II',
        pericopes: ['Matt. 8:1-13'],
        place: 'Riihimäki',
        metadata: {},
      });

      const replaced = await put(curator, `/works/${sermon.id}/occasion`, { pericopes: ['Joh. 2:1-11'] });
      expect(replaced.statusCode).toBe(200);
      expect(replaced.json().occasion).toMatchObject({ preached_on: null, place: null, pericopes: ['Joh. 2:1-11'] });

      const other = await createWork({ genre: 'letter' });
      const r = await put(curator, `/works/${other.id}/occasion`, { place: 'x' });
      expect(r.statusCode).toBe(422);
      expect((await put(contributor, `/works/${sermon.id}/occasion`, {})).statusCode).toBe(403);

      // genre cannot change away from sermon while an occasion exists (database rule -> 422)
      expect((await patch(curator, `/works/${sermon.id}`, { genre: 'homily' })).statusCode).toBe(422);
      expect((await put(curator, `/works/${sermon.id}/occasion`, { preached_on: '2024-13-01' })).statusCode).toBe(400);
    });

    it('PATCH (curator only) updates fields, rejects part_of cycles', async () => {
      const parent = await createWork();
      const child = await createWork({ part_of_work_id: parent.id });
      expect((await patch(contributor, `/works/${child.id}`, { title: 'y' })).statusCode).toBe(403);
      const res = await patch(curator, `/works/${child.id}`, { title: 'Liber I', original_languages: ['la', 'grc'] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ title: 'Liber I', original_languages: ['la', 'grc'], part_of_work_id: parent.id });

      const cycle = await patch(curator, `/works/${parent.id}`, { part_of_work_id: child.id });
      expect(cycle.statusCode).toBe(422);
      expect((await patch(curator, `/works/${parent.id}`, { part_of_work_id: parent.id })).statusCode).toBe(422);

      const audit = await ctx.pool.query(
        `SELECT action, changes FROM audit_event WHERE entity_type = 'work' AND entity_id = $1 ORDER BY occurred_at, id`,
        [child.id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['insert', 'update']);
      expect(Object.keys(audit.rows[1].changes).sort()).toEqual(['original_languages', 'title']);
    });

    it('filters works by genre, person, years and parent; hides withdrawn', async () => {
      const person = await createPerson();
      const parent = await createWork();
      const w1 = await createWork({ genre: 'homily', year_from: 390, year_to: 395, part_of_work_id: parent.id,
        persons: [{ person_id: person.id, role: 'author' }] });
      const w2 = await createWork({ genre: 'letter', year_from: 410, part_of_work_id: parent.id,
        persons: [{ person_id: person.id, role: 'attributed_author' }] });
      const w3 = await createWork({ genre: 'homily', part_of_work_id: parent.id }); // undated
      const ids = async (qs: string) =>
        (await get(reader, `/works?part_of_work_id=${parent.id}&limit=500${qs}`)).json().items.map((x: { id: string }) => x.id);
      const sorted = (...xs: string[]) => xs.sort();

      expect(await ids('')).toEqual(sorted(w1.id, w2.id, w3.id));
      expect(await ids('&genre=homily')).toEqual(sorted(w1.id, w3.id));
      expect(await ids(`&person_id=${person.id}`)).toEqual(sorted(w1.id, w2.id));
      expect(await ids('&year_from=396')).toEqual(sorted(w2.id));
      expect(await ids('&year_to=400')).toEqual(sorted(w1.id));
      expect(await ids('&year_from=394&year_to=409')).toEqual(sorted(w1.id));
      expect(await ids('&year_from=395&year_to=410')).toEqual(sorted(w1.id, w2.id));

      await post(curator, `/works/${w3.id}/withdraw`, { reason: 'test' });
      expect(await ids('')).toEqual(sorted(w1.id, w2.id));
      expect(await ids('&include_withdrawn=true')).toEqual(sorted(w1.id, w2.id, w3.id));
      expect((await get(reader, `/works/${w3.id}`)).json().withdrawn_reason).toBe('test');
      expect((await get(reader, '/works?genre=novel')).statusCode).toBe(400);
    });
  });
});
