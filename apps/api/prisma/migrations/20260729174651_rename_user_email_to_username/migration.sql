-- RenameColumn
ALTER TABLE "User" RENAME COLUMN "email" TO "username";

-- RenameIndex
DROP INDEX IF EXISTS "User_email_key";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
