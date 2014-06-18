"""
Small utilities for fixing problems that occur in the DB.
"""

import sys
import os
from pprint import pprint
from datetime import datetime, date, timedelta

from settings import *
from util import *
from datebase import db
import texts

def remove_refs_with_false():
	"""
	Removes any links and history records about links that contain False
	as one of the refs. 
	"""
	db.links.remove({"refs": False})
	db.history.remove({"new.refs": False})
	db.history.find({"new.refs": False})