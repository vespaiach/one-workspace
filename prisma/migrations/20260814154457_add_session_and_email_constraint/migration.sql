ALTER TABLE "users"
ADD CONSTRAINT "users_email_canonical"
CHECK ("email" = lower(btrim("email")));
