import Queue from 'bull';
import { ObjectId } from 'mongodb';
import dbClient from './utils/db.js';
import imageThumbnail from 'image-thumbnail';
import fs from 'fs';
import path from 'path';

const fileQueue = new Queue('fileQueue');

fileQueue.process(async (job, done) => {
  const { fileId, userId } = job.data;

  if (!fileId) throw new Error('Missing fileId');
  if (!userId) throw new Error('Missing userId');

  const file = await dbClient.db.collection('files').findOne({
    _id: ObjectId(fileId),
    userId: ObjectId(userId),
  });

  if (!file) throw new Error('File not found');
  if (file.type !== 'image') throw new Error('Not an image');

  const sizes = [500, 250, 100];
  const inputPath = file.localPath;

  try {
    for (const size of sizes) {
      const thumbnail = await imageThumbnail(inputPath, { width: size });
      const thumbPath = `${inputPath}_${size}`;
      await fs.promises.writeFile(thumbPath, thumbnail);
    }
    done();
  } catch (err) {
    console.error('Thumbnail error:', err.message);
    done(err);
  }
});
