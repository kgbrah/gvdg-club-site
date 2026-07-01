ALTER TABLE round_ratings ADD COLUMN wind_gust_mph REAL;
ALTER TABLE round_ratings ADD COLUMN weather_adjustment REAL NOT NULL DEFAULT 0;
