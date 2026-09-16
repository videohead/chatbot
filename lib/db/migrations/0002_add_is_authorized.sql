ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isAuthorized" boolean DEFAULT false NOT NULL;
UPDATE "User" SET "isAuthorized" = true WHERE "email" = 'videohead@hotmail.com';
