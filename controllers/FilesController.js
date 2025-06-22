import { ObjectId } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import Queue from 'bull';

import dbClient from '../utils/db.js';
import redisClient from '../utils/redis.js';

const FOLDER_PATH = process.env.FOLDER_PATH || '/tmp/files_manager';

const fileQueue = new Queue('fileQueue');


class FilesController {
  static async postUpload(req, res) {
    const token = req.headers['x-token'];
    const userId = await redisClient.get(`auth_${token}`);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const user = await dbClient.db.collection('users').findOne({ _id: ObjectId(userId) });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { name, type, data, parentId = 0, isPublic = false } = req.body;

    if (!name) return res.status(400).json({ error: 'Missing name' });
    if (!type || !['folder', 'file', 'image'].includes(type)) {
      return res.status(400).json({ error: 'Missing type' });
    }
    if (type !== 'folder' && !data) return res.status(400).json({ error: 'Missing data' });

    let parent = null;
    if (parentId !== 0) {
      parent = await dbClient.db.collection('files').findOne({ _id: ObjectId(parentId) });
      if (!parent) return res.status(400).json({ error: 'Parent not found' });
      if (parent.type !== 'folder') {
        return res.status(400).json({ error: 'Parent is not a folder' });
      }
    }

    const newFile = {
      userId: user._id,
      name,
      type,
      isPublic,
      parentId: parentId === 0 ? 0 : ObjectId(parentId),
    };

    if (type === 'folder') {
      const result = await dbClient.db.collection('files').insertOne(newFile);
      newFile.id = result.insertedId;
      return res.status(201).json(newFile);
    }
    if (type === 'image') {
      await fileQueue.add({ userId: user._id.toString(), fileId: result.insertedId.toString() });
    }

    await fs.promises.mkdir(FOLDER_PATH, { recursive: true });
    const filename = uuidv4();
    const localPath = path.join(FOLDER_PATH, filename);
    await fs.promises.writeFile(localPath, Buffer.from(data, 'base64'));

    newFile.localPath = localPath;
    const result = await dbClient.db.collection('files').insertOne(newFile);

    return res.status(201).json({
      id: result.insertedId,
      userId: user._id,
      name,
      type,
      isPublic,
      parentId: newFile.parentId,
    });
  }
  static async getShow(req, res) {
    const token = req.headers['x-token'];
    const userId = await redisClient.get(`auth_${token}`);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    let file;
    try {
      file = await dbClient.db.collection('files').findOne({
        _id: ObjectId(req.params.id),
        userId: ObjectId(userId),
      });
    } catch (e) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (!file) return res.status(404).json({ error: 'Not found' });

    return res.status(200).json(file);
  }
  static async getIndex(req, res) {
    const token = req.headers['x-token'];
    const userId = await redisClient.get(`auth_${token}`);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const parentId = req.query.parentId || '0';
    const page = parseInt(req.query.page || '0', 10);

    const match = {
      userId: ObjectId(userId),
      parentId: parentId === '0' ? 0 : ObjectId(parentId),
    };

    const files = await dbClient.db
      .collection('files')
      .aggregate([
        { $match: match },
        { $skip: page * 20 },
        { $limit: 20 },
      ])
      .toArray();

    return res.status(200).json(files);
  }
  static async putPublish(req, res) {
    const token = req.headers['x-token'];
    const userId = await redisClient.get(`auth_${token}`);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const fileId = req.params.id;
    const file = await dbClient.db.collection('files').findOne({
      _id: ObjectId(fileId),
      userId: ObjectId(userId),
    });

    if (!file) return res.status(404).json({ error: 'Not found' });

    await dbClient.db.collection('files').updateOne(
      { _id: ObjectId(fileId) },
      { $set: { isPublic: true } }
    );

    file.isPublic = true;
    return res.status(200).json(file);
  }
  static async putUnpublish(req, res) {
    const token = req.headers['x-token'];
    const userId = await redisClient.get(`auth_${token}`);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const fileId = req.params.id;
    const file = await dbClient.db.collection('files').findOne({
      _id: ObjectId(fileId),
      userId: ObjectId(userId),
    });

    if (!file) return res.status(404).json({ error: 'Not found' });

    await dbClient.db.collection('files').updateOne(
      { _id: ObjectId(fileId) },
      { $set: { isPublic: false } }
    );

    file.isPublic = false;
    return res.status(200).json(file);
  }
  static async getFile(req, res) {
    const fileId = req.params.id;
    const { size } = req.query;
    const allowedSizes = ['500', '250', '100'];

    let file;

    try {
      file = await dbClient.db.collection('files').findOne({ _id: ObjectId(fileId) });
    } catch (e) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (!file) return res.status(404).json({ error: 'Not found' });

    const token = req.headers['x-token'];
    let userId = null;
    if (token) userId = await redisClient.get(`auth_${token}`);

    if (!file.isPublic && (!userId || userId !== file.userId.toString())) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (file.type === 'folder') {
      return res.status(400).json({ error: "A folder doesn't have content" });
    }

    let filePath = file.localPath;
    if (size && allowedSizes.includes(size)) {
      filePath = `${file.localPath}_${size}`;
    }

    try {
      await fs.promises.access(filePath);
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }

    const mimeType = mime.lookup(file.name) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);

    const stream = fs.createReadStream(filePath);
    return stream.pipe(res);
  }
}

export default FilesController;
