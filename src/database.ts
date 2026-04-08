import mongoose, { Schema, Document } from 'mongoose';

// === Types ===

export interface IPlayer extends Document {
  name: string;
  number: number;
  position: string;
  teamId: string;
  seasonStats: {
    points: number;
    rebounds: number;
    assists: number;
    steals: number;
    blocks: number;
    gamesPlayed: number;
  };
  createdAt: Date;
}

export interface IGame extends Document {
  title: string;
  date: Date;
  opponent: string;
  context: string;
  focus: string;
  plays: IPlay[];
  insights: IInsight[];
  shotChart: {
    paint: number;
    midRange: number;
    corner3: number;
    aboveBreak3: number;
    pullUp: number;
  };
  createdAt: Date;
}

export interface IPlay {
  startTime: string;
  endTime: string;
  type: string;
  label: string;
  note: string;
  players: string[];
}

export interface IInsight {
  type: 'good' | 'warn' | 'bad';
  title: string;
  body: string;
}

// === Schemas ===

const PlayerSchema = new Schema<IPlayer>({
  name: { type: String, required: true },
  number: { type: Number, required: true },
  position: { type: String, required: false, default: '' },
  teamId: { type: String, default: '' },
  seasonStats: {
    points: { type: Number, default: 0 },
    rebounds: { type: Number, default: 0 },
    assists: { type: Number, default: 0 },
    steals: { type: Number, default: 0 },
    blocks: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 },
  },
  createdAt: { type: Date, default: Date.now },
});

const GameSchema = new Schema<IGame>({
  title: { type: String, required: true },
  date: { type: Date, default: Date.now },
  opponent: { type: String, default: '' },
  context: { type: String, default: '' },
  focus: { type: String, default: 'all' },
  plays: { type: Schema.Types.Mixed, default: [] },
  insights: { type: Schema.Types.Mixed, default: [] },
  shotChart: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
});

// === Knowledge Types & Schema ===

export interface IKnowledgeDocument {
  name: string;
  content: string;
  uploadedAt: Date;
}

export interface ITeamKnowledge extends Document {
  teamId: string;
  philosophy: string;
  offenseSystem: string;
  defenseSystem: string;
  documents: IKnowledgeDocument[];
}

const TeamKnowledgeSchema = new Schema<ITeamKnowledge>({
  teamId: { type: String, required: true, unique: true },
  philosophy: { type: String, default: '' },
  offenseSystem: { type: String, default: '' },
  defenseSystem: { type: String, default: '' },
  documents: [{
    name: { type: String, required: true },
    content: { type: String, default: '' },
    uploadedAt: { type: Date, default: Date.now },
  }],
});

// === Models ===

export const Player = mongoose.model<IPlayer>('Player', PlayerSchema);
export const Game = mongoose.model<IGame>('Game', GameSchema);
export const TeamKnowledge = mongoose.model<ITeamKnowledge>('TeamKnowledge', TeamKnowledgeSchema);

const AnalysisSchema = new mongoose.Schema({
  teamName: String,
  focus: String,
  plays: Array,
  insights: Array,
  playCount: Number,
  createdAt: { type: Date, default: Date.now },
});
export const Analysis = mongoose.model('Analysis', AnalysisSchema);

// === Connect ===

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('⚠️ MONGODB_URI not set — database disabled');
    return;
  }
  try {
    await mongoose.connect(uri);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ שגיאה בחיבור ל-MongoDB:', err);
    throw err;
  }
}
