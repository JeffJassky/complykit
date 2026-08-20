import mongoose from 'mongoose';
import mixpanel from 'mixpanel-browser';
import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic();
mixpanel.init('token');

export const UserSchema = new mongoose.Schema({
  email: { type: String },
  phone: { type: String },
  firstName: { type: String },
});
