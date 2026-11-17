const { z } = require('zod');
const { fail } = require('../utils/voiceNotes');
const service = () => require('../container').resolve('voiceNoteService');
const uuid = value => {
    if (!z.string().uuid().safeParse(value).success) throw fail('Invalid recording or submission ID.');
    return value;
};
const wrap = action => async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store');
        await action(req, res);
    } catch (error) {
        if (error.name === 'VoiceNoteError') return res.status(error.statusCode || 400).json({ error: 'VOICE_NOTE_ERROR', message: error.message });
        next(error);
    }
};
module.exports = {
    configuration: wrap(async (_req, res) => res.json(service().configuration)),
    begin: wrap(async (req, res) => res.status(201).json(await service().begin(req.body, req.scout))),
    complete: wrap(async (req, res) => res.json(await service().complete(uuid(req.params.id), req.scout))),
    ownPlayback: wrap(async (req, res) => res.json(await service().ownPlayback(uuid(req.params.id), req.scout))),
    abandon: wrap(async (req, res) => { await service().abandon(uuid(req.params.id), req.scout); res.sendStatus(204); }),
    stagedPlayback: wrap(async (req, res) => res.json(await service().playback(uuid(req.params.id), uuid(req.params.noteId), true))),
    warehousePlayback: wrap(async (req, res) => {
        if (!/^[1-9][0-9]*$/.test(req.params.id) || Number(req.params.id) > 2147483647) throw fail('Invalid warehouse ID.');
        res.json(await service().playback(Number(req.params.id), uuid(req.params.noteId)));
    }),
};
