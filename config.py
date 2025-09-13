import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv('BOT_TOKEN')
ADMIN_USER_IDS = eval(os.getenv('ADMIN_USER_IDS', '[6155502698]'))
GROUP_CHAT_ID = int(os.getenv('GROUP_CHAT_ID', '-1003026552272'))
DB_PATH = os.getenv('DB_PATH', 'team_bot.db')
PROXY_SERVER = os.getenv('PROXY_SERVER', '91.238.92.36')
PROXY_PORT = int(os.getenv('PROXY_PORT', '200'))
PROXY_SECRET = os.getenv('PROXY_SECRET', 'ee0000f00f0f775555fffffff5006e2e69646F776E6C6F61642E77696E646F77737570646174652E636F6D')