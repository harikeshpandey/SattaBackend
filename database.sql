
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
    user_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    username varchar(50) UNIQUE NOT NULL,
    password_hash varchar(255) NOT NULL,
    fake_money_balance decimal(10, 2) NOT NULL DEFAULT 1000.00,
    is_admin boolean NOT NULL DEFAULT false,
    created_at timestamp DEFAULT now()
);
CREATE TABLE players (
    player_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name varchar(100) NOT NULL,
    country varchar(50)
);
CREATE TABLE matches (
    match_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_one_id uuid REFERENCES players(player_id),
    player_two_id uuid REFERENCES players(player_id),
    match_time timestamp,
    match_status varchar(20) DEFAULT 'pending', 
    winner_id uuid REFERENCES players(player_id) NULL,
    first_scorer_id uuid REFERENCES players(player_id) NULL,
    player_one_score integer NULL,
    player_two_score integer NULL,
    total_points integer NULL,
    games_played integer NULL,
    highest_lead_amount integer NULL,
    highest_lead_player_id uuid REFERENCES players(player_id) NULL,
    first_tilt_player_id uuid REFERENCES players(player_id) NULL,
    first_abuse_player_id uuid REFERENCES players(player_id) NULL
);
CREATE TABLE odds (
    odd_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id uuid NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
    player_id uuid REFERENCES players(player_id) NULL, 
    odd_type varchar(50) NOT NULL, 
    odd_value decimal(5, 2) NOT NULL,
    odd_line decimal(5, 1) NULL,
    is_active boolean DEFAULT true
);

CREATE TABLE bets (
    bet_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    odd_id uuid NOT NULL REFERENCES odds(odd_id) ON DELETE CASCADE,
    stake_amount decimal(10, 2) NOT NULL,
    bet_status varchar(20) DEFAULT 'pending',
    payout decimal(10, 2) NULL, 
    placed_at timestamp DEFAULT now()
);
CREATE INDEX ON matches (match_status);
CREATE INDEX ON odds (match_id);
CREATE INDEX ON bets (user_id);
CREATE INDEX ON bets (odd_id);
CREATE INDEX ON bets (bet_status);
