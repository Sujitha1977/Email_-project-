# requirements.txt
"""
flask==2.3.3
scikit-learn==1.3.0
nltk==3.8.1
pandas==2.0.3
numpy==1.24.3
psycopg2-binary==2.9.7
python-dotenv==1.0.0
gunicorn==21.2.0
streamlit==1.25.0
plotly==5.15.0
wordcloud==1.9.2
"""

# config.py
import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-secret-key'
    DATABASE_URL = os.environ.get('DATABASE_URL') or 'postgresql://localhost/email_classifier'
    SQLALCHEMY_DATABASE_URI = DATABASE_URL
    SQLALCHEMY_TRACK_MODIFICATIONS = False

# database.py
import psycopg2
from psycopg2.extras import RealDictCursor
import json
from datetime import datetime
from config import Config

class DatabaseManager:
    def __init__(self):
        self.connection_string = Config.DATABASE_URL
        self.init_tables()
    
    def get_connection(self):
        return psycopg2.connect(self.connection_string, cursor_factory=RealDictCursor)
    
    def init_tables(self):
        """Initialize database tables"""
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                # Create emails table
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS emails (
                        id SERIAL PRIMARY KEY,
                        sender VARCHAR(255) NOT NULL,
                        subject TEXT NOT NULL,
                        body TEXT NOT NULL,
                        priority VARCHAR(20) NOT NULL,
                        confidence FLOAT NOT NULL,
                        scores JSONB,
                        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                """)
                
                # Create indexes for better performance
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_emails_priority ON emails(priority);
                    CREATE INDEX IF NOT EXISTS idx_emails_processed_at ON emails(processed_at);
                    CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender);
                """)
                conn.commit()
    
    def store_email(self, email_data):
        """Store classified email in database"""
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO emails (sender, subject, body, priority, confidence, scores)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING id, processed_at;
                """, (
                    email_data['sender'],
                    email_data['subject'], 
                    email_data['body'],
                    email_data['priority'],
                    email_data['confidence'],
                    json.dumps(email_data['scores'])
                ))
                result = cur.fetchone()
                conn.commit()
                return result
    
    def get_emails(self, limit=100, offset=0):
        """Retrieve emails from database"""
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM emails 
                    ORDER BY processed_at DESC 
                    LIMIT %s OFFSET %s;
                """, (limit, offset))
                return cur.fetchall()
    
    def get_stats(self):
        """Get classification statistics"""
        with self.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT 
                        COUNT(*) as total_emails,
                        AVG(confidence) as avg_confidence,
                        priority,
                        COUNT(*) as count
                    FROM emails 
                    GROUP BY priority;
                """)
                stats = cur.fetchall()
                
                cur.execute("SELECT COUNT(*) as total FROM emails;")
                total = cur.fetchone()['total']
                
                return {
                    'total_emails': total,
                    'priority_distribution': stats
                }

# model.py
import nltk
import pandas as pd
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import train_test_split
from sklearn.naive_bayes import MultinomialNB
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, accuracy_score
from sklearn.pipeline import Pipeline
import joblib
import re
from nltk.corpus import stopwords
from nltk.tokenize import word_tokenize
from nltk.stem import PorterStemmer
import string

# Download required NLTK data
try:
    nltk.data.find('tokenizers/punkt')
    nltk.data.find('corpora/stopwords')
except LookupError:
    nltk.download('punkt')
    nltk.download('stopwords')

class EmailClassifier:
    def __init__(self):
        self.model = None
        self.vectorizer = None
        self.stemmer = PorterStemmer()
        self.stop_words = set(stopwords.words('english'))
        
    def preprocess_text(self, text):
        """Clean and preprocess text data"""
        # Convert to lowercase
        text = text.lower()
        
        # Remove HTML tags
        text = re.sub(r'<[^>]+>', '', text)
        
        # Remove URLs
        text = re.sub(r'http\S+|www\S+|https\S+', '', text, flags=re.MULTILINE)
        
        # Remove email addresses
        text = re.sub(r'\S+@\S+', '', text)
        
        # Remove punctuation and numbers
        text = re.sub(r'[^a-zA-Z\s]', '', text)
        
        # Tokenize
        tokens = word_tokenize(text)
        
        # Remove stopwords and stem
        tokens = [self.stemmer.stem(token) for token in tokens 
                 if token not in self.stop_words and len(token) > 2]
        
        return ' '.join(tokens)
    
    def generate_sample_data(self, n_samples=1000):
        """Generate sample training data"""
        # Sample email templates for different priorities
        urgent_templates = [
            "URGENT: System down, immediate action required",
            "Emergency: Security breach detected in server",
            "CRITICAL: Database backup failed, data at risk",
            "ASAP: Client meeting moved to today",
            "Deadline extended to tonight only",
            "Server crash - urgent maintenance needed",
            "URGENT: Payment overdue, account suspended"
        ]
        
        important_templates = [
            "Meeting scheduled for project review tomorrow",
            "Important: Policy changes effective next month", 
            "Board meeting agenda for your review",
            "Budget approval required for Q4 expenses",
            "Performance review scheduled next week",
            "Client proposal needs final approval",
            "Important update on company restructuring"
        ]
        
        normal_templates = [
            "Weekly team update and progress report",
            "Thank you for your collaboration on the project",
            "Information regarding upcoming office hours",
            "Regular maintenance scheduled for weekend",
            "Newsletter: Latest company updates and news",
            "Reminder: Monthly team lunch next Friday",
            "Office supplies inventory update"
        ]
        
        spam_templates = [
            "You've won $1,000,000! Click here to claim",
            "Limited time offer: 90% discount on everything!",
            "Make money fast with this simple trick",
            "Hot singles in your area want to meet you",
            "Buy cheap medications online without prescription",
            "Congratulations! You're our lucky winner today",
            "Free iPhone! No strings attached, claim now"
        ]
        
        data = []
        labels = []
        
        # Generate samples for each category
        categories = [
            (urgent_templates, 'urgent', n_samples//4),
            (important_templates, 'important', n_samples//4),
            (normal_templates, 'normal', n_samples//4),
            (spam_templates, 'spam', n_samples//4)
        ]
        
        for templates, label, count in categories:
            for i in range(count):
                # Add some variation to templates
                template = np.random.choice(templates)
                variation = np.random.choice([
                    template,
                    template + " Please respond immediately.",
                    template + " Let me know if you have questions.",
                    "RE: " + template,
                    "FW: " + template
                ])
                data.append(variation)
                labels.append(label)
        
        return pd.DataFrame({'text': data, 'priority': labels})
    
    def train_model(self, data=None):
        """Train the email classification model"""
        if data is None:
            # Generate sample data if none provided
            data = self.generate_sample_data()
        
        # Preprocess text data
        data['processed_text'] = data['text'].apply(self.preprocess_text)
        
        # Split data
        X_train, X_test, y_train, y_test = train_test_split(
            data['processed_text'], data['priority'], 
            test_size=0.2, random_state=42, stratify=data['priority']
        )
        
        # Create pipeline with TF-IDF and classifier
        self.model = Pipeline([
            ('tfidf', TfidfVectorizer(max_features=5000, ngram_range=(1, 2))),
            ('classifier', MultinomialNB(alpha=0.1))
        ])
        
        # Train model
        self.model.fit(X_train, y_train)
        
        # Evaluate model
        y_pred = self.model.predict(X_test)
        accuracy = accuracy_score(y_test, y_pred)
        report = classification_report(y_test, y_pred)
        
        print(f"Model Accuracy: {accuracy:.3f}")
        print("\nClassification Report:")
        print(report)
        
        return accuracy, report
    
    def predict(self, sender, subject, body):
        """Predict email priority"""
        if self.model is None:
            raise ValueError("Model not trained. Call train_model() first.")
        
        # Combine email components
        full_text = f"{sender} {subject} {body}"
        processed_text = self.preprocess_text(full_text)
        
        # Get prediction and probability
        prediction = self.model.predict([processed_text])[0]
        probabilities = self.model.predict_proba([processed_